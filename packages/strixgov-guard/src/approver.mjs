/**
 * Approver key and signed approvals.
 *
 * The approver key is an Ed25519 key kept encrypted on disk under a passphrase
 * only the human knows. An approval is signed over the exact request the
 * human saw. A proxy configured with `requireSignedResponse` refuses any
 * approval that is not signed by a registered approver key.
 *
 * What this does and does not do: it stops an agent running as the same OS
 * user from approving its own request by writing a response file. It does not
 * stop a process that can rewrite the proxy config (which holds the trusted
 * public key) and restart the proxy, and it cannot stop offline guessing of a
 * weak passphrase against the encrypted key file. Real separation needs a
 * different OS user or host.
 *
 * The signing format duplicates @strixgov/tool-gateway's approval-signing
 * (Guard has no dependencies); test/approver.test.mjs cross-verifies the two.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { guardHome, guardPaths } from "./paths.mjs";

export const APPROVAL_SIGNATURE_VERSION = "strix-guard-approval/v1";
const KEY_FILE_AAD = Buffer.from("strix-guard-approver/v1");
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSPHRASE_LENGTH = 12;

export function approverPaths(env = process.env) {
  const dir = path.join(guardPaths(guardHome(env)).home, "approver");
  return { dir, keyPath: path.join(dir, "key.enc.json"), publicPath: path.join(dir, "public.json") };
}

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

export const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

/** Create the approver key. Refuses to overwrite one unless force is set. */
export async function createApproverKey({ passphrase, label = "approver", force = false, env = process.env } = {}) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`strix-guard: the approver passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const p = approverPaths(env);
  if (!force) {
    const exists = await fs.access(p.keyPath).then(() => true, () => false);
    if (exists) throw new Error(`strix-guard: an approver key already exists at ${p.keyPath} (use --force to replace it; existing signed approvals configuration must then be re-enabled)`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyB64u = publicKey.export({ format: "jwk" }).x;
  const kid = approverKeyId(publicKeyB64u);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  cipher.setAAD(KEY_FILE_AAD);
  const ct = Buffer.concat([cipher.update(privateKey.export({ format: "der", type: "pkcs8" })), cipher.final()]);
  const file = {
    v: 1, kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url"),
  };
  await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.keyPath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  const pub = { label, publicKey: publicKeyB64u, kid };
  await fs.writeFile(p.publicPath, JSON.stringify(pub, null, 2) + "\n", { mode: 0o600 });
  return pub;
}

/** The public half (label, publicKey, kid), or null when no approver key exists. */
export async function readApproverPublic(env = process.env) {
  try {
    const pub = JSON.parse(await fs.readFile(approverPaths(env).publicPath, "utf8"));
    if (typeof pub.publicKey !== "string" || approverKeyId(pub.publicKey) !== pub.kid) return null;
    return pub;
  } catch {
    return null;
  }
}

/** Decrypt the private key. A wrong passphrase and a damaged file are indistinguishable. */
export async function loadApproverPrivateKey({ passphrase, env = process.env }) {
  let f;
  try {
    f = JSON.parse(await fs.readFile(approverPaths(env).keyPath, "utf8"));
  } catch {
    throw new Error("strix-guard: no approver key found (run: strix-guard approver init)");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(passphrase, Buffer.from(f.salt, "base64url"), 32, { N: f.N, r: f.r, p: f.p, maxmem: SCRYPT.maxmem }), Buffer.from(f.iv, "base64url"));
    decipher.setAAD(KEY_FILE_AAD);
    decipher.setAuthTag(Buffer.from(f.tag, "base64url"));
    const der = Buffer.concat([decipher.update(Buffer.from(f.ct, "base64url")), decipher.final()]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("strix-guard: wrong passphrase, or the approver key file is damaged");
  }
}

/** What the human is shown before approving: the request file, parsed for display only. */
export function describeRequest(requestText) {
  let req;
  try { req = JSON.parse(requestText); } catch { return { ok: false, lines: ["(request file is not valid JSON; refusing to approve it)"] }; }
  const args = JSON.stringify(req.invocation?.args, null, 2) ?? "";
  return {
    ok: true,
    lines: [
      `capability: ${req.capability?.id ?? "?"}   risk: ${req.capability?.risk ?? "?"}   mode: ${req.capability?.mode ?? "?"}`,
      `action:     ${req.invocation?.action ?? "?"}`,
      `actor:      ${req.invocation?.actorId ?? "?"}`,
      `requested:  ${req.requestedAt ?? "?"}`,
      `arguments:  ${args.length > 2000 ? args.slice(0, 2000) + "\n... (truncated for display; the signature covers all of it)" : args}`,
    ],
  };
}

/**
 * Approve one pending request with a signature. Shows the request, requires
 * a typed "yes" and the passphrase, signs over the request file's exact
 * bytes, and writes the response.
 *
 * @param {string} requestId
 * @param {{ io: {isTty:boolean, confirm:(q:string)=>Promise<boolean>, secret:(q:string)=>Promise<string>, print:(l:string)=>void}, env?: object, now?: ()=>Date }} opts
 */
export async function approveSigned(requestId, { io, env = process.env, now = () => new Date() }) {
  if (!/^[a-f0-9]{16,64}$/i.test(requestId ?? "")) throw new Error(`strix-guard: '${requestId}' does not look like a request id (hex)`);
  if (!io.isTty) throw new Error("strix-guard: signed approvals need an interactive terminal (a passphrase is never read from arguments, the environment or a pipe)");
  const pub = await readApproverPublic(env);
  if (!pub) throw new Error("strix-guard: no approver key found (run: strix-guard approver init)");
  const approvalsDir = guardPaths(guardHome(env)).approvalsDir;
  const requestPath = path.join(approvalsDir, `${requestId}.request.json`);
  let text;
  try {
    text = await fs.readFile(requestPath, "utf8");
  } catch {
    throw new Error(`strix-guard: no pending request '${requestId}' (it may have timed out and been denied — run 'strix-guard pending')`);
  }
  const shown = describeRequest(text);
  for (const l of shown.lines) io.print(l);
  if (!shown.ok) throw new Error("strix-guard: refusing to approve a request it cannot display");
  if (!(await io.confirm(`Approve this request as "${pub.label}" [key ${pub.kid.slice(0, 8)}]? Type yes: `))) {
    throw new Error("strix-guard: not approved (nothing written)");
  }
  const privateKey = await loadApproverPrivateKey({ passphrase: await io.secret("Approver passphrase: "), env });
  const requestSha256 = sha256Hex(text);
  const decidedAt = now().toISOString();
  const signature = crypto.sign(null, Buffer.from(approvalPreimage({ requestId, requestSha256, approved: true, decidedAt, kid: pub.kid }), "utf8"), privateKey).toString("base64url");
  const response = { approved: true, requestSha256, decidedAt, kid: pub.kid, signature };
  const responsePath = path.join(approvalsDir, `${requestId}.response.json`);
  await fs.writeFile(responsePath, JSON.stringify(response, null, 2), { mode: 0o600 });
  return { requestId, approved: true, kid: pub.kid, label: pub.label, responsePath };
}
