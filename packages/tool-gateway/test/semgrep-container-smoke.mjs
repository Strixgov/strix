import { startSemgrepStdio, SEMGREP_IMAGE } from "../src/adapters/semgrep-pinned.mjs";
import { createGateway, generateSigningKey, MemoryStorage } from "../src/index.mjs";
import { createGovernedSemgrep, LocalApprovalLedger } from "../src/adapters/semgrep-pinned.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const output = process.env.SEMGREP_EVIDENCE_DIR || "/tmp/strix-semgrep-evidence";
mkdirSync(output, { recursive: true });
const transport = startSemgrepStdio({ timeoutMs: 30000 });
const observations = [];
const originalCall = transport.callTool.bind(transport);
transport.callTool = async (name, args) => {
  const record = { name, args, observedAt: new Date().toISOString() };
  observations.push(record);
  return originalCall(name, args);
};
const report = { image: SEMGREP_IMAGE, start: new Date().toISOString(), cases: [], toolCatalog: [], observations };
function check(label, ok, details = {}) {
  report.cases.push({ label, pass: !!ok, ...details });
  if (!ok) process.exitCode = 1;
}
try {
  const init = await transport.initialize();
  report.protocolVersion = init.protocolVersion;
  const tools = await transport.listTools();
  report.toolCatalog = tools.map(t => ({ name: t.name, description: t.description }));
  const candidate = tools.find(t => t.name === "semgrep_scan_with_custom_rule");
  if (!candidate) throw new Error("No Semgrep scan tool advertised; cannot run real-container test");
  report.selectedTool = candidate.name;
  
  // Never invoke a scan with guessed schema: require explicit fixture args.
  if (!process.env.SEMGREP_FIXTURE_ARGS_JSON) {
    report.blocked = "SEMGREP_FIXTURE_ARGS_JSON required for an approved real scan";
    check("handshake and tools/list", true);
  } else {
    const fixtureArgs = JSON.parse(process.env.SEMGREP_FIXTURE_ARGS_JSON);
    const gateway = createGateway({
      signingKey: generateSigningKey("semgrep-ci"), storage: new MemoryStorage(),
      policy: { rules: { ["mcp.semgrep." + candidate.name]: "ALLOW" }, default: "DENY" },
      capabilities: {},
    });
    const ledger = new LocalApprovalLedger();
    const identity = { tenantId: "semgrep-ci", actorId: "ci-agent", tool: candidate.name };
    const guard = createGovernedSemgrep({ gateway, transport, ledger, tenantId: identity.tenantId, actorId: identity.actorId, toolName: candidate.name });
    const token = ledger.issue({ ...identity, args: fixtureArgs });
    const allowed = await guard.execute(fixtureArgs, token);
    check("authorized scan reached actual MCP transport", allowed.ok && observations.length === 1, { decision: allowed.decision });
    const replay = await guard.execute(fixtureArgs, token);
    check("replay denied before actual MCP transport", replay.decision === "DENY" && observations.length === 1);
    const changed = { ...fixtureArgs, __strix_mutated: true };
    const mutation = await guard.execute(changed, ledger.issue({ ...identity, args: fixtureArgs }));
    check("mutation denied before actual MCP transport", mutation.decision === "DENY" && observations.length === 1);
    const unauthorized = createGovernedSemgrep({ gateway, transport, ledger, tenantId: identity.tenantId, actorId: "unauthorized-agent", toolName: candidate.name });
    const other = await unauthorized.execute(fixtureArgs, ledger.issue({ ...identity, args: fixtureArgs }));
    check("unauthorized agent denied before real transport", other.decision === "DENY" && observations.length === 1);
    const concurrentToken = ledger.issue({ ...identity, args: fixtureArgs });
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => guard.execute(fixtureArgs, concurrentToken)));
    check("concurrent reuse at most one real transport dispatch",
      concurrent.filter(x => x.decision === "ALLOW").length <= 1 && observations.length <= 2,
      { observed: observations.length });
    const unavailableGateway = {
      registerCapability() {},
      async execute() { throw new Error("gateway unavailable"); },
      async recordDenial() { throw new Error("gateway unavailable"); },
    };
    const failClosed = createGovernedSemgrep({
      gateway: unavailableGateway, transport, ledger,
      tenantId: identity.tenantId, actorId: identity.actorId, toolName: candidate.name,
    });
    const before = observations.length;
    let unavailableRejected = false;
    try { await failClosed.execute(fixtureArgs, ledger.issue({ ...identity, args: fixtureArgs })); }
    catch { unavailableRejected = true; }
    check("gateway unavailable fails closed before real transport",
      unavailableRejected && observations.length === before);
    report.receipts = await gateway.listReceipts();
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  report.end = new Date().toISOString();
  transport.close();
  const json = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(output + "/report.json", json);
  const hash = createHash("sha256").update(json).digest("hex");
  writeFileSync(output + "/SHA256SUMS", hash + "  report.json\n");
  console.log(JSON.stringify({ cases: report.cases, error: report.error, blocked: report.blocked, hash }));
}
