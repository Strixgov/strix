/**
 * Verifier round-trip — proves the claim in README.md that receipts
 * produced by `@strixgov/mcp-adapter` are byte-compatible with
 * `@strixgov/verifier`.
 *
 * `@strixgov/verifier` is now a real runtime dependency of this package
 * (required by the `npx @strixgov/mcp-adapter demo` CLI in bin/demo.mjs);
 * the import below should always resolve in a normal install. The
 * try/catch is retained as defense-in-depth — the philosophical
 * independence claim still holds at the package level: the verifier
 * imports nothing from Strix, so any third party can swap in a
 * standalone Ed25519+SHA-256 implementation that speaks the public JWKS
 * contract and get the same answer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { governMCPServer } from "../src/index.mjs";

let verifier;
try {
  verifier = await import("@strixgov/verifier");
} catch {
  verifier = null;
}

test(
  "MCP-adapter receipts verify under @strixgov/verifier (byte-compat round-trip)",
  { skip: verifier ? false : "@strixgov/verifier not resolvable in this layout" },
  async () => {
    const tools = {
      "notion-fetch":          async ({ id }) => ({ id, title: "Demo doc" }),
      "notion-create-comment": async ({ pageId, body }) => ({ id: "c1", pageId, body }),
    };

    const srv = governMCPServer(tools, {
      serverId: "notion",
      capabilities: [
        { id: "mcp.notion.fetch",          name: "notion-fetch",          risk: "LOW",    mode: "READ"  },
        { id: "mcp.notion.create_comment", name: "notion-create-comment", risk: "MEDIUM", mode: "WRITE" },
      ],
      policy: {
        rules: {
          "mcp.notion.fetch":          "ALLOW",
          "mcp.notion.create_comment": "DENY",
        },
        default: "DENY",
      },
    });

    const receipts = [];
    srv.gateway.on("receipt", (r) => receipts.push(r));

    // One ALLOW path, one DENY path. Both should verify — the verifier's
    // job is to confirm the receipt is genuine, not to express an opinion
    // on whether the underlying action was permitted.
    await srv.callTool("notion-fetch", { id: "doc_demo" });
    await assert.rejects(() => srv.callTool("notion-create-comment", { pageId: "doc_demo", body: "x" }));

    assert.equal(receipts.length, 2, "two receipts emitted");
    assert.equal(receipts[0].decision, "ALLOW");
    assert.equal(receipts[1].decision, "DENY");

    // Build the JWKS the verifier needs from the adapter's signing key.
    // In a real deployment this is published at /.well-known/strix-jwks.json
    // (or whatever endpoint the operator exposes). For the round-trip we
    // hand it in directly.
    const jwks = { keys: [srv.signingKey.publicKeyJwk] };

    for (const receipt of receipts) {
      const out = await verifier.verifyReceipt(receipt, { jwks });
      assert.equal(
        out.verificationStatus,
        "VERIFIED",
        `receipt ${receipt.receiptId} (${receipt.decision}) must verify — got ${out.verificationStatus} (${out.error ?? "no error"})`,
      );
      assert.equal(out.signaturePresent, true);
      assert.equal(out.signatureValid, true);
      assert.equal(out.hashValid, true);
    }
  },
);
