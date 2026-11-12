/**
 * Signed approval responses for the file approver.
 *
 * Why: a plain `<id>.response.json` can be written by any process running as
 * the same OS user, including the agent being governed. A signed response
 * must come from a holder of an approver key, over exactly the request the
 * human saw.
 *
 * Honest limit: this stops forging an approval by writing a file. It does not
 * stop a process that can rewrite the verifier's configured public key and
 * restart the proxy. Stronger separation needs a different OS user or host.
 *
 * Preimage (domain separated, not JSON, so no canonicalisation is involved):
 *   strix-guard-approval/v1\n
 *   request:<requestId>\n
 *   requestSha256:<hex of the exact request file bytes the proxy wrote>\n
 *   approved:<true|false>\n
 *   decidedAt:<ISO 8601 UTC>\n
 *   kid:<approver key id>
 */
import crypto from "node:crypto";

export const APPROVAL_SIGNATURE_VERSION = "strix-guard-approval/v1";
export const DEFAULT_MAX_RESPONSE_AGE_MS = 10 * 60_000;

const B64URL = /^[A-Za-z0-9_-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Key id: first 16 hex chars of sha256 over the raw 32-byte public key. */
export function approverKeyId(publicKeyB64u) {
  return crypto.createHash("sha256").update(Buffer.from(publicKeyB64u, "base64url")).digest("hex").slice(0, 16);
}

export function approvalPreimage({ requestId, requestSha256, approved, decidedAt, kid }) {
  return [
    APPROVAL_SIGNATURE_VERSION,
    `request:${requestId}`,
    `requestSha256:${requestSha256}`,
    `approved:${approved === true ? "true" : "false"}`,
    `decidedAt:${decidedAt}`,
    `kid:${kid}`,
  ].join("\n");
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Sign an approval decision. `privateKey` is a Node KeyObject (Ed25519). */
export function signApprovalResponse({ privateKey, kid, requestId, requestSha256, approved, decidedAt }) {
  const preimage = approvalPreimage({ requestId, requestSha256, approved, decidedAt, kid });
  return crypto.sign(null, Buffer.from(preimage, "utf8"), privateKey).toString("base64url");
}

function publicKeyObject(publicKeyB64u) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64u }, format: "jwk" });
}

/** Validate configured approver keys; throws on anything malformed (fail closed). */
export function normalizeApproverKeys(approverKeys) {
  if (!Array.isArray(approverKeys) || approverKeys.length === 0) {
    throw new Error("approval.approverKeys must be a non-empty array when signed responses are required");
  }
  return approverKeys.map((k, i) => {
    if (!k || typeof k.publicKey !== "string" || !B64URL.test(k.publicKey) || Buffer.from(k.publicKey, "base64url").length !== 32) {
      throw new Error(`approval.approverKeys[${i}].publicKey must be a base64url Ed25519 public key (32 bytes)`);
    }
    const kid = approverKeyId(k.publicKey);
    if (k.kid !== undefined && k.kid !== kid) {
      throw new Error(`approval.approverKeys[${i}].kid does not match its public key`);
    }
    return { kid, publicKey: k.publicKey, label: typeof k.label === "string" && k.label ? k.label : "approver", key: publicKeyObject(k.publicKey) };
  });
}

/**
 * Verify an APPROVING response. Returns { ok: true, approver } or
 * { ok: false, reason: "APPROVAL_UNSIGNED" | "APPROVAL_SIGNATURE_INVALID" }.
 * Never throws.
 */
export function verifyApprovalResponse({ response, requestId, requestSha256, keys, now = Date.now(), maxAgeMs = DEFAULT_MAX_RESPONSE_AGE_MS }) {
  try {
    const sig = response?.signature;
    if (typeof sig !== "string" || sig.length === 0) return { ok: false, reason: "APPROVAL_UNSIGNED" };
    if (!B64URL.test(sig)) return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
    if (response.approved !== true) return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
    const decidedAt = response.decidedAt;
    if (typeof decidedAt !== "string" || !ISO_UTC.test(decidedAt)) return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
    const t = Date.parse(decidedAt);
    if (!Number.isFinite(t) || now - t > maxAgeMs || t - now > 60_000) return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
    const key = keys.find((k) => k.kid === response.kid);
    if (!key) return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
    const preimage = approvalPreimage({ requestId, requestSha256, approved: true, decidedAt, kid: key.kid });
    const ok = crypto.verify(null, Buffer.from(preimage, "utf8"), key.key, Buffer.from(sig, "base64url"));
    return ok ? { ok: true, approver: { kid: key.kid, label: key.label } } : { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
  } catch {
    return { ok: false, reason: "APPROVAL_SIGNATURE_INVALID" };
  }
}
