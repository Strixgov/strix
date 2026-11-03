/**
 * Payload-bound, single-use, expiring egress authorization — the property
 * this feature INHERITS from the Strix token model rather than re-inventing
 * weaker (spec §8): an authorization binds the exact sanitized artifact
 * bytes (by hash), the prompt bytes (by hash), the destination, and the
 * purpose; it expires; and it is consumable exactly once.
 *
 * The prompt is bound deliberately even though the spec's §10 matrix does
 * not list it: the outbound request to a provider is artifact + prompt, and
 * an unbound prompt would be a second, ungoverned channel to the same
 * destination — authorize a sanitized document, smuggle raw PHI in the
 * prompt. The pipeline additionally SCANS the prompt (see pipeline.mjs);
 * the binding here is what makes a post-authorization prompt swap a
 * PROMPT_MISMATCH refusal.
 *
 * SUBORDINATE AS OF PHASE B — read this before using it for anything new.
 * The kernel binding shipped, and on that path this module authorizes
 * NOTHING: the Strix Decision is the authorization, single-use comes from
 * the kernel's own token redemption, and payload binding comes from the
 * canonical egress commitment (see commitment/egress-commitment.mjs). Two
 * mechanisms that can each permit an egress would be a parallel
 * authorization system, which is the thing the Gate-D scope law forbids.
 *
 * So this module is now the LOCAL-MODE fallback only — the dormant v0.1
 * path, kept because it is what the package does with no kernel reachable,
 * and because deleting it would delete the tests that pin the substitution
 * refusal at the local gate. `kernel/production-binding.mjs` and
 * `egress/kernel-gate.mjs` deliberately do NOT import it, and a structural
 * test pins that they never will: the moment the kernel path could reach
 * this mint, "the kernel is the authority" would stop being true.
 *
 * `bindingAddress` below is likewise SUPERSEDED on the kernel path. It
 * covers five components; the commitment covers seventeen, including the
 * verification outcome, the policy identity and the tenant — the fields
 * that make a commitment specific enough to be worth signing.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex, isBareHash } from '../artifact/hash.mjs';

export const DEFAULT_AUTHORIZATION_TTL_MS = 5 * 60 * 1000; // mirror Strix token default

/**
 * Composite binding address over every bound component. A JSON.stringify'd
 * TUPLE, not a delimiter join — ("ab","c") and ("a","bc") must never share
 * an address (the NUL-separator collision class recorded in this repo's
 * client-profile work), and JSON array encoding is collision-free for
 * string components.
 */
export function bindingAddress({ artifactHash, promptHash, provider, service, purpose }) {
  for (const [name, v] of [['artifactHash', artifactHash], ['promptHash', promptHash]]) {
    if (!isBareHash(v)) throw new TypeError(`bindingAddress: ${name} must be bare 64-hex sha256`);
  }
  for (const [name, v] of [['provider', provider], ['service', service], ['purpose', purpose]]) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(`bindingAddress: ${name} must be a non-empty string`);
    }
  }
  return sha256Hex(JSON.stringify([artifactHash, promptHash, provider, service, purpose]));
}

/**
 * In-memory single-use authorization store (v0.1). The claim is a
 * synchronous check-and-set with no await between check and set — atomic
 * under JS run-to-completion, so two concurrent release attempts cannot
 * both claim one authorization. A future durable store must implement
 * `claim` with the same atomicity (claim-by-INSERT / conditional UPDATE —
 * the CN-7 discipline), never read-then-write.
 */
export function createInMemoryAuthorizationStore() {
  const records = new Map();
  return {
    put(auth) {
      if (records.has(auth.authorizationId)) {
        throw new Error('authorization id collision');
      }
      records.set(auth.authorizationId, { ...auth });
    },
    get(id) {
      const a = records.get(id);
      return a === undefined ? null : { ...a };
    },
    /** Atomically consume. Returns true exactly once per authorization. */
    claim(id, consumedAtIso) {
      const a = records.get(id);
      if (a === undefined || a.consumedAt !== undefined) return false;
      a.consumedAt = consumedAtIso;
      return true;
    },
  };
}

/**
 * Mint an egress authorization bound to the exact release payload.
 * Minting grants nothing by itself — release still re-derives every hash
 * from the actual outbound bytes at the gate.
 */
export function mintEgressAuthorization({
  store,
  artifactHash,
  promptHash,
  destination,
  purpose,
  ttlMs = DEFAULT_AUTHORIZATION_TTL_MS,
  now = Date.now,
}) {
  const binding = bindingAddress({
    artifactHash,
    promptHash,
    provider: destination.provider,
    service: destination.service,
    purpose,
  });
  const issuedAtMs = now();
  const auth = {
    authorizationId: randomBytes(16).toString('hex'),
    artifactHash,
    promptHash,
    destination: { provider: destination.provider, service: destination.service },
    purpose,
    binding,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAtMs: issuedAtMs + ttlMs,
  };
  store.put(auth);
  return auth;
}
