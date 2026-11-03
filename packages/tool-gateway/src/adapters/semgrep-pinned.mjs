/** Pinned Semgrep MCP stdio transport. Local-only; no production activation. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const SEMGREP_IMAGE = "ghcr.io/semgrep/mcp@sha256:fe599c63be2689f551925d223e0cacd5d3a38074be932ecca2ea05ee365539e5";
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  if (keys.some(k => value[k] === undefined)) throw new TypeError("undefined argument");
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
export function actionDigest(action) {
  return createHash("sha256").update(canonical(action)).digest("hex");
}
export function startSemgrepStdio({ spawnImpl = spawn, timeoutMs = 15000 } = {}) {
  const proc = spawnImpl("docker", [
    "run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL", "--tmpfs", "/home/app/.semgrep:rw,nosuid,nodev,size=16m,mode=1777",
    "-e", "SEMGREP_MCP_DISABLE_TRACING=true", "-e", "SEMGREP_SEND_METRICS=off",
    "--entrypoint", "semgrep-mcp", SEMGREP_IMAGE, "-t", "stdio",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  let stderr = "";
  proc.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  function failAll(error) {
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }
  proc.on("error", failAll);
  proc.on("exit", (code) => failAll(new Error("Semgrep MCP exited " + code + ": " + stderr)));
  proc.stdout.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 8_000_000) { failAll(new Error("MCP response buffer exceeded")); proc.kill(); return; }
    for (;;) {
      const pos = buffer.indexOf("\n");
      if (pos < 0) break;
      const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!Object.hasOwn(msg, "id")) continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error("MCP " + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  function send(message) {
    if (closed || !proc.stdin.writable) throw new Error("MCP transport unavailable");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("MCP transport unavailable"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP timeout: " + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  async function initialize() {
    const result = await request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "strix-semgrep-pinned", version: "0.1.0" },
    });
    if (result?.protocolVersion !== "2025-06-18") throw new Error("Unexpected MCP protocol version");
    send({ method: "notifications/initialized" });
    return result;
  }
  return {
    initialize,
    async listTools() { return (await request("tools/list")).tools ?? []; },
    async callTool(name, args) { return request("tools/call", { name, arguments: args }); },
    close() { proc.kill(); },
  };
}

/**
 * Process-local, single-use approval consumption. NOT durable or distributed.
 * Only the trusted host should call issue(); never expose it to the MCP client.
 */
export class LocalApprovalLedger {
  #grants = new Map();
  issue({ tenantId, actorId, tool, args, ttlMs = 60000 }) {
    if (!tenantId || !actorId || !tool || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("Invalid grant");
    const token = randomUUID();
    const digest = actionDigest({ tenantId, actorId, tool, args });
    this.#grants.set(token, { digest, expires: Date.now() + ttlMs });
    return token;
  }
  consume(token, action) {
    const grant = this.#grants.get(token);
    if (!grant) return false;
    // Remove synchronously before any await; concurrent calls cannot both consume.
    this.#grants.delete(token);
    return grant.expires > Date.now() && grant.digest === actionDigest(action);
  }
}

/**
 * Mandatory trusted identity comes from host construction, not caller context.
 * Calls through the existing gateway, then the real downstream MCP transport.
 */
export function createGovernedSemgrep({ gateway, transport, ledger, tenantId, actorId, toolName }) {
  if (!gateway || !transport || !ledger || !tenantId || !actorId || !toolName) throw new TypeError("Missing governed Semgrep dependency");
  const capability = { id: "mcp.semgrep." + toolName, name: toolName, risk: "HIGH", mode: "EXECUTE" };
  gateway.registerCapability(capability);
  return {
    async execute(args, approvalToken) {
      const action = { tenantId, actorId, tool: toolName, args };
      // Snapshot validated arguments before any async dispatch.
      let frozenArgs;
      try { frozenArgs = JSON.parse(canonical(args)); }
      catch { return { ok: false, decision: "DENY", reason: "INVALID_ARGUMENTS" }; }
      if (!(await ledger.consume(approvalToken, action))) {
        const receipt = await gateway.recordDenial({
          invocation: { capabilityId: capability.id, action: "mcp.callTool:" + toolName, args: frozenArgs, actorId },
          capability, reason: "APPROVAL_MISSING_EXPIRED_OR_MISMATCHED",
        });
        return { ok: false, decision: "DENY", receipt };
      }
      return gateway.execute({
        capabilityId: capability.id, action: "mcp.callTool:" + toolName,
        args: frozenArgs, actorId,
      }, () => transport.callTool(toolName, frozenArgs));
    },
  };
}
