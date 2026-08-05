/**
 * Cross-package dogfood: a REAL MC-1 receipt → a VERIFIED visual receipt.
 *
 *   node --import tsx --test test/dogfood-mc1.test.ts
 *
 * No scaffolds. A producer signs a real `mcp_proof_v1` bundle with @strixgov/sdk
 * (real Ed25519), a neutral verifier resolves the key from the published JWKS
 * and runs the real `verifyMcpProof`, and that verdict flows through
 * `mapMc1ToVisualReceipt` + the renderers. Because MC-1 is ACTIVE by default
 * (promoted 2026-06-02) there is NO process-local promotion here — this is the
 * post-flip reality: a production-shaped receipt renders VERIFIED.
 *
 * Proves the structural-mirror design: a real `McpProofRecord` satisfies
 * `McpProofRecordView` and a real `McpProofVerificationResult` satisfies
 * `Verdict`, with no runtime dependency on the SDK.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Real SDK surface, from the built dist of the sibling package.
import {
  makeMcpProofPayload,
  makeMcpServer,
  makeToolCall,
  makeExecutionReceipt,
  Ed25519Keyring,
  signMcpProof,
  verifyMcpProof,
} from "../../governance-sdk/dist/mcp-proof/index.js";
import { nodeEd25519Verifier } from "../../governance-sdk/dist/crypto/ed25519-node.js";
import { OriginScopedJwksResolver } from "../../governance-sdk/dist/jwks/index.js";

import { mapMc1ToVisualReceipt, type McpProofRecordView } from "../src/mapMc1ToVisualReceipt.js";
import { renderVisualReceiptSvg } from "../src/renderSvg.js";
import { renderVisualReceiptHtml } from "../src/renderHtml.js";

const ISS = "https://www.strixgov.com";
const TENANT = "tenant-vr-dogfood";
const PARAMS_HASH = "a".repeat(64);
const SCHEMA_HASH = "b".repeat(64);

function buildPayload() {
  return makeMcpProofPayload({
    evidence_id: "ev-vr-dogfood-1",
    principal_attestation: {
      payload: { evidence_id: "ev-principal", actor_class: "system", actor_id: "agent_runtime", credential_class: "service_token", tenant_id: TENANT, environment: "prod", attested_at: "2026-06-02T12:00:00Z", capability_id: "AA-1", iss: ISS },
      signature: "", kid: "strix-prod-2026-05", created_at: "2026-06-02T12:00:01Z",
    },
    agent_attestation: {
      payload: { evidence_id: "ev-agent", actor_class: "agent", actor_id: "outreach_agent_v1", credential_class: "agent_token", tenant_id: TENANT, environment: "prod", attested_at: "2026-06-02T12:00:00Z", capability_id: "AA-1", iss: ISS },
      signature: "", kid: "strix-agent-2026-05", created_at: "2026-06-02T12:00:01Z",
    },
    device_attestation: null,
    plan_hash: "0x" + "d".repeat(64),
    capability_id: "MC-1",
    tenant_id: TENANT,
    mcp_server: makeMcpServer("outreach.internal", "tenant_internal", "tenant-account:7"),
    tool_call: makeToolCall("outreach.internal", "prepare_message", "high", PARAMS_HASH, SCHEMA_HASH),
    execution_receipt: makeExecutionReceipt("success", "r".repeat(64), "", "2026-06-02T12:00:01Z", "2026-06-02T12:00:02Z"),
    attested_at: "2026-06-02T12:00:02Z",
    iss: ISS,
  });
}

const planResolver = {
  resolve: () => ({
    approved_at: "2026-06-02T11:00:00Z",
    allowed_tools: ["prepare_message"],
    bound_params_hash: { prepare_message: PARAMS_HASH },
    bound_params_schema_hash: { prepare_message: SCHEMA_HASH },
  }),
};

test("dogfood: a real MC-1 receipt renders a VERIFIED visual receipt (MC-1 ACTIVE, no scaffold)", () => {
  // ── Producer signs for real + publishes the origin-scoped JWKS ──
  const keyring = new Ed25519Keyring();
  const record = signMcpProof(buildPayload(), "strix-prod-2026-05", keyring, "2026-06-02T12:00:03Z");
  assert.match(record.signature, /^[0-9a-f]{128}$/);

  const resolver = new OriginScopedJwksResolver();
  for (const [origin, doc] of keyring.jwksByOrigin()) resolver.addOrigin(origin, doc);

  // ── Neutral verifier: real Ed25519 + key from the JWKS. No withActive(). ──
  const verdict = verifyMcpProof(record, {
    signatureVerifier: nodeEd25519Verifier,
    jwksResolver: resolver,
    planResolver,
    boundEvidenceOccurredAt: "2026-06-02T12:00:00Z",
  });
  assert.equal(verdict.valid, true, `expected VERIFIED, got ${verdict.failingRule}/${verdict.reason}/${verdict.detail}`);

  // ── The verdict flows through the visual-receipt projection ──
  const manifest = mapMc1ToVisualReceipt(record as unknown as McpProofRecordView, verdict, {
    keyResolvable: true,
    humanApprovalRequired: true,
    notSent: true, // "prepare_message" = drafted, not sent
  });
  assert.equal(manifest.proof.verificationStatus, "VERIFIED");
  assert.equal(manifest.decisionStatus, "APPROVAL_REQUIRED");
  assert.equal(manifest.executionStatus, "NOT_SENT");
  assert.equal(manifest.proof.signatureValid, true);

  const svg = renderVisualReceiptSvg(manifest);
  const html = renderVisualReceiptHtml(manifest);
  assert.match(svg, /VERIFIED/);
  assert.match(svg, /#1a7f37/); // GREEN

  // Emit sample artifacts for inspection (dist/ is gitignored).
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "samples");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "visual-receipt-mc1-verified.svg"), svg);
  writeFileSync(join(outDir, "visual-receipt-mc1-verified.html"), html);
});
