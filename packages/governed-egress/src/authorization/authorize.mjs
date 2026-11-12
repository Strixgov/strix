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
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
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
 * The principal an authorization is bound to: the tenant and actor the
 * INTEGRATOR's authenticated context supplied when the grant was minted.
 * This package authenticates nobody (see `actorAuthentication` in
 * types.d.ts): binding stops a grant minted for one principal being spent by
 * another between authorization and release; it does not establish that the
 * named principal is who they claim to be. Supply the principal from your
 * own authenticated session (the proxy uses its configuration), never from a
 * request field the caller controls.
 *
 * Both components are nullable so a deployment with no principal concept
 * keeps matching (null === null). The address is a JSON tuple for the same
 * collision reason as `bindingAddress`.
 */
export function normalizeGrantPrincipal(principal) {
  const tenant = principal?.tenant ?? null;
  const actor = principal?.actor ?? null;
  for (const [name, v] of [['tenant', tenant], ['actor', actor]]) {
    if (v !== null && (typeof v !== 'string' || v.length === 0)) {
      throw new TypeError(`principal.${name} must be a non-empty string or null`);
    }
  }
  return { tenant, actor };
}

export function principalAddress(principal) {
  const { tenant, actor } = normalizeGrantPrincipal(principal);
  return sha256Hex(JSON.stringify(['strix-egress-principal-v1', tenant, actor]));
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
    topology: 'SINGLE_PROCESS',
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
    /**
     * Atomically consume. Returns true exactly once per authorization, and
     * never for a revoked one: consumption and revocation are one terminal
     * state, so at most one of them ever happens.
     */
    claim(id, consumedAtIso) {
      const a = records.get(id);
      if (a === undefined || a.consumedAt !== undefined || a.revokedAt !== undefined) return false;
      a.consumedAt = consumedAtIso;
      return true;
    },
    /**
     * Withdraw an unspent grant. Returns true if this call revoked it; false
     * if it was unknown, already consumed, or already revoked. A claimed
     * grant cannot be revoked: the transport may already have run.
     */
    revoke(id, { revokedAtIso = new Date().toISOString(), reason = null } = {}) {
      const a = records.get(id);
      if (a === undefined || a.consumedAt !== undefined || a.revokedAt !== undefined) return false;
      a.revokedAt = revokedAtIso;
      a.revocationReason = reason;
      return true;
    },
  };
}

const AUTHORIZATION_ID = /^[0-9a-f]{32}$/;

function writeExclusive(path, text) {
  // 'wx' is O_CREAT|O_EXCL: the create happens exactly once across every
  // process sharing the directory, or fails with EEXIST. fsync before close
  // so a crash cannot leave a claim a restarted process does not see.
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Durable, cross-process authorization store for ONE host.
 *
 * Supported topology: several processes (for example several proxy workers)
 * on one host sharing a LOCAL directory. Single use holds across them because
 * a grant's terminal state is one marker file created with O_EXCL:
 * consumption and revocation race for the same file, so exactly one wins,
 * once. Not supported: network filesystems (O_EXCL is not reliably atomic on
 * every NFS configuration) and several hosts. Those need a shared
 * transactional store, which this package does not ship.
 *
 * A grant file is written once and never rewritten; a reader sees the grant
 * plus, at most, one terminal marker.
 */
export function createFileAuthorizationStore({ directory } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('createFileAuthorizationStore: directory is required');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const validId = (id) => typeof id === 'string' && AUTHORIZATION_ID.test(id);
  const grantPath = (id) => join(directory, `${id}.grant.json`);
  const finalPath = (id) => join(directory, `${id}.final.json`);
  const finalize = (id, state) => {
    try {
      writeExclusive(finalPath(id), JSON.stringify(state));
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      throw err;
    }
  };
  return {
    topology: 'SINGLE_HOST_MULTI_PROCESS',
    directory,
    put(auth) {
      if (!validId(auth?.authorizationId)) {
        throw new TypeError('authorization id must be 32 lowercase hex characters');
      }
      try {
        writeExclusive(grantPath(auth.authorizationId), JSON.stringify(auth));
      } catch (err) {
        if (err?.code === 'EEXIST') throw new Error('authorization id collision');
        throw err;
      }
    },
    get(id) {
      if (!validId(id)) return null;
      const auth = readJsonOrNull(grantPath(id));
      if (auth === null) return null;
      const final = readJsonOrNull(finalPath(id));
      if (final?.state === 'consumed') return { ...auth, consumedAt: final.at };
      if (final?.state === 'revoked') return { ...auth, revokedAt: final.at, revocationReason: final.reason ?? null };
      return { ...auth };
    },
    claim(id, consumedAtIso) {
      if (!validId(id) || readJsonOrNull(grantPath(id)) === null) return false;
      return finalize(id, { state: 'consumed', at: consumedAtIso });
    },
    revoke(id, { revokedAtIso = new Date().toISOString(), reason = null } = {}) {
      if (!validId(id) || readJsonOrNull(grantPath(id)) === null) return false;
      return finalize(id, { state: 'revoked', at: revokedAtIso, reason });
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
  principal = null,
  ttlMs = DEFAULT_AUTHORIZATION_TTL_MS,
  now = Date.now,
}) {
  const boundPrincipal = normalizeGrantPrincipal(principal);
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
    principal: boundPrincipal,
    principalHash: principalAddress(boundPrincipal),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAtMs: issuedAtMs + ttlMs,
  };
  store.put(auth);
  return auth;
}
