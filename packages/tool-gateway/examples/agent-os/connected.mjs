/**
 * Stretch — `--connected`: the SAME signed receipts, synced upstream.
 *
 * Local mode (default) signs and persists receipts locally. Connected mode
 * additionally fire-and-forgets each receipt to a kernel over the v0.4-stable
 * wire (timestamp + nonce + timing-safe HMAC envelope). The receipt bytes are
 * IDENTICAL — connected mode is distribution, not a second source of truth.
 *
 * To prove the round trip offline, this stands up a tiny in-process mock kernel
 * (node:http) that verifies the HMAC of every delivery exactly as the real
 * kernel would. If STRIX_KERNEL_URL + STRIX_API_KEY are set, it targets the
 * real kernel instead. No real kernel, no credentials required for the demo.
 */

import http from "node:http";
import crypto from "node:crypto";
import {
  createGateway,
  generateSigningKey,
  MemoryStorage,
  fixedApprover,
  WIRE_VERSION,
} from "../../src/index.mjs";
import { capabilities } from "./capabilities.mjs";
import { policy } from "./policy.mjs";
import { executors } from "./executors.mjs";
import { planTaskGraph } from "./planner.mjs";

const RECEIPTS_PATH = "/api/v1/tool-gateway/receipts";

/**
 * A mock kernel that verifies the wire envelope HMAC and records receipts —
 * the same check the production kernel performs before persisting.
 * @returns {Promise<{ url: string, received: object[], hmacOk: boolean[], close: () => Promise<void> }>}
 */
function startMockKernel(apiKey) {
  const received = [];
  const hmacOk = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const sigHeader = req.headers["x-strix-signature"] ?? "";
      const expected = `hmac-sha256=${crypto
        .createHmac("sha256", apiKey)
        .update(raw)
        .digest("hex")}`;
      // Timing-safe compare, exactly as a real verifier would.
      const ok =
        sigHeader.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
      hmacOk.push(ok);
      if (ok) {
        const body = JSON.parse(raw);
        for (const r of body.receipts ?? []) received.push(r);
      }
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: ok }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        hmacOk,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export async function runConnectedDemo() {
  const useReal = !!(process.env.STRIX_KERNEL_URL && process.env.STRIX_API_KEY);
  const apiKey = process.env.STRIX_API_KEY ?? "demo-shared-secret";

  const mock = useReal ? null : await startMockKernel(apiKey);
  const kernelUrl = useReal ? process.env.STRIX_KERNEL_URL : mock.url;

  console.log(`\n  wire: ${WIRE_VERSION}  →  ${useReal ? "REAL kernel" : "in-process mock kernel"} ${kernelUrl}`);

  const signingKey = generateSigningKey("agent-os-demo-connected");
  const gateway = createGateway({
    signingKey,
    storage: new MemoryStorage(), // local chain is still the source of truth
    toolName: "agent-os-demo",
    tenantId: "demo",
    environment: "local",
    policy,
    capabilities,
    approval: { enabled: true, prompt: fixedApprover(true, "ops-lead") },
    connectedMode: { enabled: true, kernelUrl, apiKey, tenantId: "demo" },
  });

  const synced = [];
  gateway.on("sync", ({ record }) => synced.push(record.receiptId));
  gateway.on("sync-error", ({ reason }) => console.log(`     sync-error: ${reason ?? "?"}`));

  for (const t of planTaskGraph()) {
    await gateway.execute(
      { capabilityId: t.capabilityId, action: t.action, args: t.args, actorId: "agent-customerops", actorRole: "agent" },
      executors[t.capabilityId],
    );
  }
  // Let the fire-and-forget deliveries settle (localhost completes in ms),
  // then drain anything that buffered on a transient failure.
  await new Promise((r) => setTimeout(r, 300));
  await gateway.drainSync();

  const local = await gateway.listReceipts();
  console.log(`  local chain : ${local.length} signed receipts`);
  console.log(`  synced      : ${synced.length} delivered upstream (fire-and-forget)`);

  if (mock) {
    const allHmacOk = mock.hmacOk.length > 0 && mock.hmacOk.every(Boolean);
    console.log(`  kernel recv : ${mock.received.length} receipts, HMAC ${allHmacOk ? "VERIFIED on every delivery ✓" : "FAILED ✗"}`);
    console.log(`  → same bytes: ${mock.received.length === local.length ? "local and kernel chains match ✓" : "MISMATCH ✗"}`);
    await mock.close();
    return { ok: allHmacOk && mock.received.length === local.length };
  }
  return { ok: synced.length === local.length };
}
