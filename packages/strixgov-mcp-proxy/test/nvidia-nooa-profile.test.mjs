import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleDir = path.resolve(here, "../examples/nvidia-nooa");

test("NOOA .mcp.json launches the Strix proxy over stdio with trusted identity", async () => {
  const config = JSON.parse(
    await fs.readFile(path.join(exampleDir, ".mcp.json"), "utf8"),
  );
  const server = config.mcpServers.strix_secure_coding;
  assert.equal(server.transport, "stdio");
  assert.match(server.args.join(" "), /strix-mcp-proxy\.mjs/);
  assert.equal(server.env.STRIX_REQUIRE_TRUSTED_IDENTITY, "true");
  assert.match(server.env.STRIX_TRUSTED_ACTOR_ID, /^spiffe:\/\//);
  assert.equal(server.env.STRIX_TENANT_ID, "nvidia-nooa-demo");
  assert.equal(server.env.STRIX_ENVIRONMENT, "openshell");
});

test("NOOA proxy policy is fail-closed and protects consequential actions", async () => {
  const config = JSON.parse(
    await fs.readFile(path.join(exampleDir, "proxy-config.json"), "utf8"),
  );
  assert.equal(config.policy.default, "DENY");
  assert.equal(
    config.policy.rules["mcp.nooa-secure-coding.inspect_repository"],
    "ALLOW",
  );
  assert.equal(
    config.policy.rules["mcp.nooa-secure-coding.propose_patch"],
    "ALLOW",
  );
  assert.equal(
    config.policy.rules["mcp.nooa-secure-coding.merge_production"],
    "APPROVAL_REQUIRED",
  );
  assert.equal(
    config.policy.rules["mcp.nooa-secure-coding.rotate_credentials"],
    "DENY",
  );
  assert.equal(config.approval.type, "file");
  assert.ok(config.storagePath);
  assert.ok(config.keyPath);
});

test("OpenShell template leaves Python without ordinary downstream egress", async () => {
  const policy = await fs.readFile(
    path.join(exampleDir, "openshell-policy.yaml"),
    "utf8",
  );
  assert.match(policy, /^version: 1/m);
  assert.match(policy, /run_as_user: sandbox/);
  assert.match(policy, /api\.github\.com/);
  assert.match(policy, /protocol: rest/);
  assert.match(policy, /tls: terminate/);
  assert.match(policy, /enforcement: enforce/);
  assert.match(policy, /access: read-only/);
  assert.doesNotMatch(policy, /path: \/usr\/bin\/python/);
  assert.doesNotMatch(policy, /path: \/usr\/local\/bin\/python/);
});

test("NOOA agent uses MCPManager.create_from_server", async () => {
  const source = await fs.readFile(path.join(exampleDir, "nooa_agent.py"), "utf8");
  assert.match(source, /MCPManager\.create_from_server/);
  assert.match(source, /strix_secure_coding/);
});
