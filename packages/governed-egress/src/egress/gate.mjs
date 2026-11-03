/**
 * THE STRIX EGRESS GATE — the boundary that carries the invariant this
 * package exists for:
 *
 *   The artifact inspected and authorized by Strix must be the artifact
 *   actually transmitted to the AI provider.
 *
 * How that holds structurally, not by caller discipline:
 *  - The gate re-derives sha256 over the ACTUAL bytes it is about to
 *    transmit (artifact text and prompt) and compares each against the
 *    authorization's bound hashes. There is no API path that accepts an
 *    authorization id plus arbitrary content and skips the comparison —
 *    the substitution vulnerability the spec bolds (§8).
 *  - The transport receives ONLY the verified pieces, from inside this
 *    function, after the checks. A caller never hands the transport
 *    anything directly.
 *  - The authorization is consumed ATOMICALLY before the transport runs
 *    (redeem-before-side-effect, the Strix ordering), so a replay finds it
 *    already spent. Binding mismatches do NOT consume — a mismatch is a
 *    refused substitution, and refusing without burning the grant mirrors
 *    Strix token redemption (an attacker cannot succeed without the exact
 *    bytes, and possessing the exact bytes is the authorized release).
 *  - Attempt evidence is written BEFORE the transport; if the evidence
 *    write fails, the release refuses (EVIDENCE_UNAVAILABLE) with the
 *    authorization already burned — the safe direction: never a provider
 *    call that no record precedes, and never a refunded grant on a crash
 *    (the reservation-before-transport rule).
 *  - Outcome honesty: transport success is 'completed'; a transport
 *    timeout is 'unknown', NEVER 'failed' — the request may have reached
 *    the provider, and for a data-release boundary "unknown" means
 *    POSSIBLY DISCLOSED, which downstream accounting must treat as
 *    disclosure until shown otherwise. Only a refusal path may claim the
 *    provider was never contacted.
 */
import { sha256Hex } from '../artifact/hash.mjs';

export const EGRESS_REFUSAL_CODES = Object.freeze([
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZATION_UNKNOWN',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_CONSUMED',
  'ARTIFACT_MISMATCH',
  'PROMPT_MISMATCH',
  'DESTINATION_MISMATCH',
  'PURPOSE_MISMATCH',
  'EVIDENCE_UNAVAILABLE',
]);

function refusal(reasonCode, detail) {
  return {
    released: false,
    decision: 'DENY',
    reasonCode,
    detail,
    execution: 'not_attempted',
    disclosureStatus: 'not_disclosed',
  };
}

/**
 * Disclosure accounting is a SEPARATE axis from execution outcome, because
 * they answer different questions (the dependency-governance "disposition
 * orthogonal to retry safety" lesson, applied to data release):
 *  - an HTTP error response means the provider RECEIVED the payload and
 *    refused the request — execution 'failed', disclosure 'disclosed';
 *  - a timeout or network error means the payload MAY have landed —
 *    'possibly_disclosed', which downstream accounting must treat as
 *    disclosure until shown otherwise;
 *  - only a throw that provably preceded any I/O ('unconfigured') is
 *    'not_disclosed'. Unknown error kinds fail toward 'possibly_disclosed'.
 */
function disclosureStatusFor(execution, errorKind) {
  if (execution === 'completed') return 'disclosed';
  if (errorKind === 'http') return 'disclosed';
  if (errorKind === 'unconfigured') return 'not_disclosed';
  return 'possibly_disclosed';
}

function tryAppendDenial(evidence, fields) {
  // Enforcement outranks evidence on REFUSAL paths (the solo-builder-core
  // rule): a denial evidence-write failure must never convert a DENY into
  // anything else, so this is best-effort and loud.
  try {
    evidence.append({ type: 'egress_denied', ...fields });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[governed-egress] denial evidence write failed:', err?.message);
  }
}

/**
 * Release verified content through the gate to a transport.
 *
 * @param {{
 *   store: { get(id), claim(id, iso) },
 *   evidence: { append(entry) },
 *   transport: { name: string, send({ documentText, prompt, purpose, destination }) },
 *   authorizationId: string | undefined,
 *   artifactText: string,
 *   prompt: string,
 *   destination: { provider: string, service: string },
 *   purpose: string,
 *   now?: () => number,
 * }} input
 */
export async function releaseThroughGate(input) {
  const { store, evidence, transport, authorizationId, artifactText, prompt, destination, purpose } = input;
  const now = input.now ?? Date.now;

  const presentedArtifactHash = sha256Hex(artifactText ?? '');
  const presentedPromptHash = sha256Hex(prompt ?? '');
  const denialBase = {
    presentedArtifactHash,
    presentedPromptHash,
    destination: { provider: destination?.provider, service: destination?.service },
    purpose,
  };

  if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
    const r = refusal('AUTHORIZATION_REQUIRED', 'no egress authorization was presented');
    tryAppendDenial(evidence, { ...denialBase, reasonCode: r.reasonCode });
    return r;
  }

  const auth = store.get(authorizationId);
  if (auth === null) {
    const r = refusal('AUTHORIZATION_UNKNOWN', 'no such authorization');
    tryAppendDenial(evidence, { ...denialBase, reasonCode: r.reasonCode });
    return r;
  }

  let r = null;
  if (now() > auth.expiresAtMs) {
    r = refusal('AUTHORIZATION_EXPIRED', 'authorization expired before release');
  } else if (auth.consumedAt !== undefined) {
    r = refusal('AUTHORIZATION_CONSUMED', 'authorization was already consumed');
  } else if (presentedArtifactHash !== auth.artifactHash) {
    r = refusal('ARTIFACT_MISMATCH', 'outbound artifact bytes do not match the authorized artifact hash');
  } else if (presentedPromptHash !== auth.promptHash) {
    r = refusal('PROMPT_MISMATCH', 'outbound prompt bytes do not match the authorized prompt hash');
  } else if (
    destination?.provider !== auth.destination.provider ||
    destination?.service !== auth.destination.service
  ) {
    r = refusal('DESTINATION_MISMATCH', 'destination does not match the authorized destination');
  } else if (purpose !== auth.purpose) {
    r = refusal('PURPOSE_MISMATCH', 'purpose does not match the authorized purpose');
  }
  if (r !== null) {
    tryAppendDenial(evidence, { ...denialBase, authorizationId, reasonCode: r.reasonCode });
    return r;
  }

  // Atomic consume — redeem strictly before any side effect. A lost race
  // reports CONSUMED; the transport has not run on this path.
  if (!store.claim(authorizationId, new Date(now()).toISOString())) {
    const lost = refusal('AUTHORIZATION_CONSUMED', 'authorization was consumed concurrently');
    tryAppendDenial(evidence, { ...denialBase, authorizationId, reasonCode: lost.reasonCode });
    return lost;
  }

  // Attempt evidence BEFORE the side effect. A failed write refuses with
  // the provider untouched; the consumed grant stays consumed (safe
  // direction — never refund authority on a crash path).
  try {
    evidence.append({
      type: 'egress_attempt',
      authorizationId,
      binding: auth.binding,
      artifactHash: auth.artifactHash,
      promptHash: auth.promptHash,
      destination: { ...auth.destination },
      purpose: auth.purpose,
      transportName: transport.name,
    });
  } catch (err) {
    return {
      released: false,
      decision: 'DENY',
      reasonCode: 'EVIDENCE_UNAVAILABLE',
      detail: `attempt evidence could not be written (${err?.message}); the provider was never contacted, and the authorization is spent`,
      execution: 'not_attempted',
      disclosureStatus: 'not_disclosed',
    };
  }

  let execution;
  let providerMeta = null;
  let responseText = null;
  let transportError = null;
  try {
    const result = await transport.send({
      documentText: artifactText,
      prompt,
      purpose: auth.purpose,
      destination: { ...auth.destination },
    });
    execution = 'completed';
    providerMeta = result?.providerMeta ?? null;
    responseText = result?.responseText ?? null;
  } catch (err) {
    // Timeout is UNKNOWN, not FAILED: the payload may have reached the
    // provider and only the response was lost — possibly disclosed.
    execution = err?.kind === 'timeout' ? 'unknown' : 'failed';
    transportError = { kind: err?.kind ?? 'error', message: String(err?.message ?? err) };
  }

  let outcomeEvidenceRecorded = true;
  try {
    evidence.append({
      type: 'egress_outcome',
      authorizationId,
      binding: auth.binding,
      execution,
      disclosureStatus: disclosureStatusFor(execution, transportError?.kind),
      transportName: transport.name,
      ...(providerMeta ? { providerMeta } : {}),
      ...(transportError ? { transportError } : {}),
    });
  } catch (err) {
    outcomeEvidenceRecorded = false;
    // The send already happened — never pretend it did not. Loud, and
    // reported on the result rather than swallowed.
    // eslint-disable-next-line no-console
    console.error('[governed-egress] outcome evidence write failed:', err?.message);
  }

  return {
    released: execution === 'completed',
    decision: 'ALLOW',
    execution,
    disclosureStatus: disclosureStatusFor(execution, transportError?.kind),
    authorizationId,
    binding: auth.binding,
    providerMeta,
    responseText,
    transportError,
    outcomeEvidenceRecorded,
  };
}
