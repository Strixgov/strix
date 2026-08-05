/**
 * `strix-guard pending | approve | deny` — the human side of the loop.
 *
 * The decision channel is the tool-gateway file-approver contract:
 * a blocked call writes `<requestId>.request.json` into the guard's
 * approvals dir and polls for `<requestId>.response.json`. These
 * commands list the pending requests and write the response file —
 * `{ approved, approvedBy, reason }` — which the waiting proxy picks up
 * and (on approve) lets the original call proceed, minting its signed
 * receipt.
 *
 * A request that already timed out (proxy gave up and denied) is
 * cleaned up by the approver itself; responding to a vanished request
 * is a no-op error, never a retroactive approval.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardHome, guardPaths } from "./paths.mjs";

/** List pending approval requests. Returns [{ requestId, requestedAt, capabilityId, action, argsPreview }]. */
export async function listPending(opts = {}) {
  const paths = guardPaths(guardHome(opts.env ?? process.env));
  const entries = await fs.readdir(paths.approvalsDir).catch(() => []);
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".request.json")) continue;
    const requestId = name.slice(0, -".request.json".length);
    try {
      const req = JSON.parse(await fs.readFile(path.join(paths.approvalsDir, name), "utf8"));
      let argsPreview = "";
      try {
        const s = JSON.stringify(req.invocation?.args);
        argsPreview = s && s.length > 120 ? `${s.slice(0, 117)}...` : (s ?? "");
      } catch {
        argsPreview = "<unserializable>";
      }
      out.push({
        requestId,
        requestedAt: req.requestedAt,
        capabilityId: req.capability?.id ?? req.invocation?.capabilityId,
        risk: req.capability?.risk,
        action: req.invocation?.action,
        argsPreview,
      });
    } catch {
      out.push({ requestId, requestedAt: null, capabilityId: "<unreadable request file>" });
    }
  }
  out.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  return out;
}

/**
 * Write the response file for a pending request.
 *
 * @param {string} requestId
 * @param {{ approved: boolean, by?: string, reason?: string, env?: NodeJS.ProcessEnv }} opts
 */
export async function respond(requestId, opts) {
  if (!/^[a-f0-9]{16,64}$/i.test(requestId ?? "")) {
    throw new Error(`strix-guard: '${requestId}' does not look like a request id (hex)`);
  }
  const paths = guardPaths(guardHome(opts.env ?? process.env));
  const requestPath = path.join(paths.approvalsDir, `${requestId}.request.json`);
  try {
    await fs.access(requestPath);
  } catch {
    throw new Error(
      `strix-guard: no pending request '${requestId}' (it may have timed out and been denied — run 'strix-guard pending')`,
    );
  }
  const approvedBy = opts.by ?? safeUsername();
  const response = {
    approved: opts.approved === true,
    approvedBy,
    reason: opts.reason ?? (opts.approved ? "USER_APPROVED" : "USER_DENIED"),
  };
  const responsePath = path.join(paths.approvalsDir, `${requestId}.response.json`);
  await fs.writeFile(responsePath, JSON.stringify(response, null, 2), { mode: 0o600 });

  // Local-only activation state: record the first human approval moment.
  if (response.approved) {
    try {
      const state = JSON.parse(await fs.readFile(paths.statePath, "utf8").catch(() => "{}"));
      if (!state.firstApprovalAt) {
        state.firstApprovalAt = new Date().toISOString();
        await fs.writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      }
    } catch {
      /* state is best-effort; the approval itself already succeeded */
    }
  }
  return { requestId, ...response, responsePath };
}

function safeUsername() {
  try {
    return os.userInfo().username || "strix-guard";
  } catch {
    return "strix-guard";
  }
}
