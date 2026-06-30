/**
 * `verifyBundle` / `verify` — the proof_bundle_v2 outer-envelope verifier.
 *
 * Behaviour-faithful TS port of `solo_builder.bundle_verifier`. Five fixed
 * steps, short-circuit on the first failure:
 *
 *   envelope → decision → execution_receipt → actor_attestation → tool_call_receipts
 *
 * Three verdicts: VERIFIED, INVALID (with `failingStep` + `failingIndex`),
 * and LEGACY_UNSIGNED (no `signed_envelope` — never VERIFIED, never silently
 * allowed; ADR-005 AT#6). Crypto + key resolution are injected; this module
 * owns the orchestration and the committed-hash chain.
 */

import { canonicalize, hashCanonical } from "./canonical.js";
import { lookupStatus, ReservationStatus } from "../transaction-proof/capabilities.js";
import { hexToBytes } from "../transaction-proof/actor-attestation.js";
import type {
  AttestationAuthorityResolver,
  FailingStep,
  JwksResolver,
  SignatureVerifier,
  SubResult,
  VerificationResult,
  VerificationStatus,
} from "./types.js";

type Dict = Record<string, any>;

const ok = (name: string): SubResult => ({ name, passed: true });
const no = (name: string, error: string): SubResult => ({ name, passed: false, error });

function envelopePayload(envelope: Dict): Uint8Array {
  const copy: Dict = {};
  for (const k of Object.keys(envelope)) if (k !== "signature") copy[k] = envelope[k];
  return canonicalize(copy);
}

function verifyEnvelope(bundle: Dict, sig: SignatureVerifier, jwks: JwksResolver): SubResult {
  const envelope = bundle.signed_envelope;
  if (envelope === null || typeof envelope !== "object") {
    return no("envelope", "signed_envelope missing or not an object");
  }
  for (const key of ["kid", "signature", "committed_hashes"]) {
    if (!(key in envelope)) return no("envelope", `signed_envelope.${key} missing`);
  }
  const kid: string = envelope.kid;
  const iss = envelope.iss ?? null;

  let publicKey: Uint8Array | null;
  if (iss !== null) {
    try {
      // eslint-disable-next-line no-new
      new URL(String(iss));
    } catch {
      return no("envelope", `signed_envelope.iss is not a valid JWKS origin URL: ${iss}`);
    }
    publicKey = jwks.publicKey(kid, String(iss));
    if (publicKey === null) return no("envelope", `unknown (iss, kid) pair: (${iss}, ${kid})`);
  } else {
    publicKey = jwks.publicKey(kid);
    if (publicKey === null) return no("envelope", `unknown kid: ${kid}`);
  }

  let signature: Uint8Array;
  try {
    signature = hexToBytes(String(envelope.signature));
  } catch {
    return no("envelope", "signature is not hex-encoded bytes");
  }
  if (!sig.verify(envelopePayload(envelope), signature, publicKey)) {
    return no("envelope", "signature verification failed");
  }
  return ok("envelope");
}

function verifyCommittedHash(name: string, subRecord: unknown, expectedHex: string): SubResult {
  const actual = hashCanonical(subRecord);
  return actual === expectedHex ? ok(name) : no(name, `hash mismatch: expected ${expectedHex}, got ${actual}`);
}

function verifyDecision(bundle: Dict, committed: Dict): SubResult {
  const record = bundle.decision_record;
  if (record === null || typeof record !== "object") return no("decision", "decision_record missing or not an object");
  const expected = committed.decision_record;
  if (typeof expected !== "string") return no("decision", "committed_hashes.decision_record missing");
  return verifyCommittedHash("decision", record, expected);
}

function verifyExecutionReceipt(bundle: Dict, committed: Dict): SubResult {
  const receipt = bundle.execution_receipt;
  if (receipt === null || typeof receipt !== "object") return no("execution_receipt", "execution_receipt missing or not an object");
  const expected = committed.execution_receipt;
  if (typeof expected !== "string") return no("execution_receipt", "committed_hashes.execution_receipt missing");
  return verifyCommittedHash("execution_receipt", receipt, expected);
}

function verifyActorAttestation(
  bundle: Dict,
  committed: Dict,
  sig: SignatureVerifier,
  authorityResolver: AttestationAuthorityResolver | null,
): SubResult {
  const attestation = bundle.actor_attestation;
  if (attestation === null || typeof attestation !== "object") {
    return no("actor_attestation", "actor_attestation missing or not an object");
  }
  const expected = committed.actor_attestation;
  if (typeof expected !== "string") return no("actor_attestation", "committed_hashes.actor_attestation missing");

  const hashCheck = verifyCommittedHash("actor_attestation", attestation, expected);
  if (!hashCheck.passed) return hashCheck;

  const capabilityId = attestation.capability_id;
  if (typeof capabilityId === "string") {
    // Reserved-but-not-active (or unknown) capability cited in a signed
    // record fails — the held-PR promotion gate (ADR-003), enforced.
    if (lookupStatus(capabilityId) !== ReservationStatus.ACTIVE) {
      return no("actor_attestation", `capability ${capabilityId} rejected with capability_reserved_not_active`);
    }
  }

  const authority = attestation.attestation_authority ?? null;
  const signature = attestation.attestation_signature ?? null;
  if (authority === null || signature === null) {
    return no("actor_attestation", "attestation_authority or attestation_signature missing");
  }
  if (authorityResolver === null) {
    return no("actor_attestation", "no authority resolver supplied to verify attestation signature");
  }
  const publicKey = authorityResolver.authorityPublicKey(String(authority));
  if (publicKey === null) return no("actor_attestation", `unknown attestation authority: ${authority}`);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(String(signature));
  } catch {
    return no("actor_attestation", "attestation_signature is not hex-encoded bytes");
  }
  const copy: Dict = {};
  for (const k of Object.keys(attestation)) if (k !== "attestation_signature") copy[k] = attestation[k];
  if (!sig.verify(canonicalize(copy), signatureBytes, publicKey)) {
    return no("actor_attestation", "attestation authority signature verification failed");
  }
  return ok("actor_attestation");
}

function verifyToolCallReceipts(bundle: Dict, committed: Dict): [SubResult, number | null] {
  let receipts = bundle.tool_call_receipts;
  if (receipts === undefined || receipts === null) receipts = [];
  if (!Array.isArray(receipts)) {
    return [no("tool_call_receipts", "tool_call_receipts is not an array"), null];
  }
  const expectedRoot = committed.tool_call_receipts_root;
  const actualRoot = hashCanonical(receipts);
  if (typeof expectedRoot === "string" && actualRoot !== expectedRoot) {
    return [no("tool_call_receipts", `receipts root mismatch: expected ${expectedRoot}, got ${actualRoot}`), null];
  }
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index];
    if (receipt === null || typeof receipt !== "object") {
      return [no("tool_call_receipts", `receipts[${index}] is not an object`), index];
    }
    const argsHash = receipt.args_hash;
    if (typeof argsHash === "string") {
      const recomputed = hashCanonical(receipt.args !== undefined && receipt.args !== null ? receipt.args : {});
      if (recomputed !== argsHash) {
        return [no("tool_call_receipts", `receipts[${index}] args_hash mismatch`), index];
      }
    }
  }
  return [ok("tool_call_receipts"), null];
}

export interface VerifyBundleOptions {
  signatureVerifier: SignatureVerifier;
  jwks: JwksResolver;
  authorityResolver?: AttestationAuthorityResolver | null;
}

const STEP: Record<string, FailingStep> = {
  envelope: "envelope",
  decision: "decision",
  execution_receipt: "execution_receipt",
  actor_attestation: "actor_attestation",
  tool_call_receipts: "tool_call_receipts",
};

export function verifyBundle(bundle: Dict, opts: VerifyBundleOptions): VerificationResult {
  const { signatureVerifier, jwks, authorityResolver = null } = opts;
  const subResults: SubResult[] = [];

  const envelope = verifyEnvelope(bundle, signatureVerifier, jwks);
  subResults.push(envelope);
  if (!envelope.passed) return invalid("envelope", null, envelope.error, subResults);

  const committed = bundle.signed_envelope.committed_hashes;

  const decision = verifyDecision(bundle, committed);
  subResults.push(decision);
  if (!decision.passed) return invalid("decision", null, decision.error, subResults);

  const execution = verifyExecutionReceipt(bundle, committed);
  subResults.push(execution);
  if (!execution.passed) return invalid("execution_receipt", null, execution.error, subResults);

  const attestation = verifyActorAttestation(bundle, committed, signatureVerifier, authorityResolver);
  subResults.push(attestation);
  if (!attestation.passed) return invalid("actor_attestation", null, attestation.error, subResults);

  const [receipts, failingIndex] = verifyToolCallReceipts(bundle, committed);
  subResults.push(receipts);
  if (!receipts.passed) return invalid("tool_call_receipts", failingIndex, receipts.error, subResults);

  return { status: "VERIFIED", subResults };
}

function invalid(
  step: string,
  failingIndex: number | null,
  error: string | null | undefined,
  subResults: SubResult[],
): VerificationResult {
  return {
    status: "INVALID" as VerificationStatus,
    failingStep: STEP[step],
    failingIndex,
    error: error ?? null,
    subResults,
  };
}

/**
 * Single entrypoint mirroring the `@strixgov/verifier` v2 API. A record with
 * no `signed_envelope` is a legacy v1 record → LEGACY_UNSIGNED (the explicit
 * "not a v2 bundle" signal; never mistaken for VERIFIED).
 */
export function verify(recordOrBundle: Dict, opts: VerifyBundleOptions): VerificationResult {
  if (!("signed_envelope" in recordOrBundle)) {
    return {
      status: "LEGACY_UNSIGNED",
      subResults: [no("envelope", "no signed_envelope present")],
    };
  }
  return verifyBundle(recordOrBundle, opts);
}
