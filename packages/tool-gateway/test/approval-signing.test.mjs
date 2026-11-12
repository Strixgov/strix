/**
 * Signed approval responses (fileApprover requireSignedResponse).
 * Each rejection test is an attack a same-user process could try.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileApprover } from "../src/approval.mjs";
import { signApprovalResponse, approverKeyId, sha256Hex } from "../src/approval-signing.mjs";

const cap = { id: "filesystem.write", name: "filesystem.write", risk: "HIGH", mode: "WRITE" };
const inv = { capabilityId: "filesystem.write", action: "fs.writeFile", args: { path: "/synthetic/x" }, actorId: "agent" };

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  return { privateKey, x, kid: approverKeyId(x) };
}

async function setup(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-sign-"));
  const human = newKey();
  const prompt = fileApprover({
    requestDir: dir, timeoutMs: 3000, pollIntervalMs: 20,
    requireSignedResponse: true,
    approverKeys: [{ publicKey: human.x, label: "alice" }],
    ...opts,
  });
  return { dir, human, prompt };
}

/** Wait for the request file; return { requestId, text }. */
async function waitRequest(dir) {
  for (let i = 0; i < 100; i++) {
    const f = (await fs.readdir(dir)).find((n) => n.endsWith(".request.json"));
    if (f) return { requestId: f.replace(".request.json", ""), text: await fs.readFile(path.join(dir, f), "utf8") };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no request file");
}
const respond = (dir, id, body) => fs.writeFile(path.join(dir, `${id}.response.json`), JSON.stringify(body));
function signed({ key, requestId, text, approved = true, decidedAt = new Date().toISOString(), kid = key.kid }) {
  const requestSha256 = sha256Hex(text);
  return { approved, requestSha256, decidedAt, kid, signature: signApprovalResponse({ privateKey: key.privateKey, kid, requestId, requestSha256, approved, decidedAt }) };
}

test("a correctly signed approval is accepted and the approver identity comes from the key, not the file", async () => {
  const { dir, human, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  await respond(dir, requestId, { ...signed({ key: human, requestId, text }), approvedBy: "ceo@example.com (forged label)" });
  const r = await p;
  assert.equal(r.approved, true);
  assert.equal(r.approvedBy, `alice [key ${human.kid.slice(0, 8)}]`);
});

test("an unsigned approval is refused when signing is required (the 0.1.3 self-approval)", async () => {
  const { dir, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId } = await waitRequest(dir);
  await respond(dir, requestId, { approved: true, approvedBy: "alice@example.com (human reviewer)" });
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_UNSIGNED" });
});

test("an approval signed by an unregistered key is refused", async () => {
  const { dir, prompt } = await setup();
  const attacker = newKey();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  await respond(dir, requestId, signed({ key: attacker, requestId, text }));
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("claiming a registered kid but signing with another key is refused", async () => {
  const { dir, human, prompt } = await setup();
  const attacker = newKey();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  await respond(dir, requestId, signed({ key: attacker, kid: human.kid, requestId, text }));
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("a valid signature for a different request cannot be replayed", async () => {
  const { dir, human, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  const otherId = crypto.randomBytes(16).toString("hex");
  await respond(dir, requestId, signed({ key: human, requestId: otherId, text }));
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("a signature over different request content is refused (the args the human saw must match)", async () => {
  const { dir, human, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId } = await waitRequest(dir);
  await respond(dir, requestId, signed({ key: human, requestId, text: JSON.stringify({ benign: "args" }) }));
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("a signed DENIAL cannot be flipped into an approval by editing the flag", async () => {
  const { dir, human, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  await respond(dir, requestId, { ...signed({ key: human, requestId, text, approved: false }), approved: true });
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("a stale signed approval is refused", async () => {
  const { dir, human, prompt } = await setup({ maxResponseAgeMs: 1000 });
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  await respond(dir, requestId, signed({ key: human, requestId, text, decidedAt: new Date(Date.now() - 60_000).toISOString() }));
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
});

test("denials never need a signature (a forged denial can only deny)", async () => {
  const { dir, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId } = await waitRequest(dir);
  await respond(dir, requestId, { approved: false });
  assert.deepEqual(await p, { approved: false, reason: "USER_DENIED" });
});

test("signing required with no usable keys fails at construction, never at the first approval", () => {
  assert.throws(() => fileApprover({ requireSignedResponse: true }), /approverKeys/);
  assert.throws(() => fileApprover({ requireSignedResponse: true, approverKeys: [] }), /approverKeys/);
  assert.throws(() => fileApprover({ requireSignedResponse: true, approverKeys: [{ publicKey: "not-a-key" }] }), /publicKey/);
  const k = newKey();
  assert.throws(() => fileApprover({ requireSignedResponse: true, approverKeys: [{ publicKey: k.x, kid: "0000000000000000" }] }), /kid/);
});

test("without requireSignedResponse the old behaviour is unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strix-sign-legacy-"));
  const p = fileApprover({ requestDir: dir, timeoutMs: 2000, pollIntervalMs: 20 })(cap, inv);
  const { requestId } = await waitRequest(dir);
  await respond(dir, requestId, { approved: true, approvedBy: "bob" });
  assert.deepEqual(await p, { approved: true, reason: "USER_APPROVED", approvedBy: "bob" });
});

test("fields the response supplies cannot choose what the signature is checked against", async () => {
  // Replay: a valid signature for ANOTHER request, with that request's id and
  // hash written into the response file, must not be verified against them.
  const { dir, human, prompt } = await setup();
  const p = prompt(cap, inv);
  const { requestId, text } = await waitRequest(dir);
  const otherId = crypto.randomBytes(16).toString("hex");
  const otherText = JSON.stringify({ some: "other request" });
  await respond(dir, requestId, { ...signed({ key: human, requestId: otherId, text: otherText }), requestId: otherId });
  assert.deepEqual(await p, { approved: false, reason: "APPROVAL_SIGNATURE_INVALID" });
  void text;
});
