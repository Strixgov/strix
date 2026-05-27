/**
 * Approval prompts.
 *
 * Hard rules (all approvers):
 *   - Default to deny. Anything other than an explicit yes is a denial.
 *   - Timeout fires deny, not allow. A non-responding approver is the
 *     same as a "no".
 *   - Approver errors fail closed.
 *
 * v0.1.1 ships two first-class approvers:
 *   - `terminalApprove` — interactive y/N prompt; refuses non-TTY.
 *   - `fileApprover`    — file-watcher pattern for headless / CI /
 *                          containerised agents. The agent writes a
 *                          request file, an out-of-band approver writes
 *                          a response file, the gateway reads it.
 *
 * `fixedApprover` and `alwaysDenyApprover` are exported for tests.
 */

import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {import("./types.d.ts").ToolCapability} capability
 * @param {import("./types.d.ts").ToolInvocation} invocation
 * @param {import("./types.d.ts").ApprovalPromptOptions} [opts]
 * @returns {Promise<import("./types.d.ts").ApprovalResult>}
 */
export async function terminalApprove(capability, invocation, opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Headless / non-interactive — fail closed.
  if (!stdin || stdin.isTTY === false || (process.stdout && stdout.isTTY === false && stdout === process.stdout)) {
    if (process.stdin.isTTY !== true) {
      return {
        approved: false,
        reason: "PROMPT_FAILED",
      };
    }
  }

  const banner = formatPrompt(capability, invocation, opts.prompt);
  stdout.write(banner);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(result);
    };

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const timer = setTimeout(() => {
      stdout.write(`\n[strix-gateway] approval timed out after ${timeoutMs}ms — denying.\n`);
      finish({ approved: false, reason: "TIMEOUT" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    rl.question("Approve? [y/N]: ", (answer) => {
      const norm = String(answer ?? "").trim().toLowerCase();
      if (norm === "y" || norm === "yes") {
        finish({
          approved: true,
          reason: "USER_APPROVED",
          approvedBy: process.env.USER || process.env.USERNAME || "local",
        });
      } else {
        finish({ approved: false, reason: "USER_DENIED" });
      }
    });

    rl.on("error", () => finish({ approved: false, reason: "PROMPT_FAILED" }));
  });
}

function formatPrompt(capability, invocation, custom) {
  if (typeof custom === "string") return custom + "\n";
  const argsPreview = previewArgs(invocation.args);
  const lines = [
    "",
    "─── Strix Gateway · Approval Required ───────────────────────────────",
    `  Tool action     : ${invocation.action}`,
    `  Capability      : ${capability.id}${capability.name ? ` (${capability.name})` : ""}`,
    `  Risk            : ${capability.risk}`,
    `  Mode            : ${capability.mode}`,
    `  Actor           : ${invocation.actorId ?? "<unknown>"}${invocation.actorRole ? ` [${invocation.actorRole}]` : ""}`,
    `  Args            : ${argsPreview}`,
    "─────────────────────────────────────────────────────────────────────",
    "",
  ];
  return lines.join("\n");
}

function previewArgs(args) {
  if (args === undefined || args === null) return "<none>";
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    return "<unserializable>";
  }
  return s.length > 240 ? s.slice(0, 237) + "..." : s;
}

/**
 * File-watcher approver — first-class headless / CI primitive.
 *
 * Behaviour per call:
 *   1. Generate a fresh requestId (16 random bytes hex).
 *   2. Write `<dir>/<requestId>.request.json` containing the capability,
 *      invocation, requestedAt, and a `requestId` echo. mode 0600.
 *   3. Poll for `<dir>/<requestId>.response.json` every `pollIntervalMs`.
 *   4. On response, parse `{ approved: boolean, approvedBy?: string,
 *      reason?: string }`. Anything not `approved === true` is a denial.
 *   5. Always cleans up both files before returning.
 *   6. Timeout, parse error, IO error → DENY.
 *
 * The on-disk schema:
 *
 *   request.json:
 *     { requestId, requestedAt, capability: {id,name,risk,mode},
 *       invocation: {capabilityId,action,args,actorId,actorRole} }
 *
 *   response.json (you write this out-of-band):
 *     { approved: true|false, approvedBy?: "alice", reason?: "..." }
 *
 * Out-of-band you wire whatever channel you need (Slack bot, GitHub
 * Action, on-call rotation, paper sign-off) to write the response file.
 * The approver doesn't care how it got there.
 *
 * This intentionally has no dependency on the network. Webhook /
 * Slack / GitHub-checks adapters belong on top of this primitive,
 * not inside it.
 *
 * @param {{
 *   requestDir?: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   onRequestWritten?: (requestPath: string, requestId: string) => void | Promise<void>,
 * }} [opts]
 */
export function fileApprover(opts = {}) {
  const requestDir = opts.requestDir ?? "./.strix-approvals";
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 min default; CI is slow
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const onRequestWritten = opts.onRequestWritten;

  return async function fileApproverPrompt(capability, invocation, callOpts = {}) {
    const effectiveTimeout = callOpts.timeoutMs ?? timeoutMs;

    let requestId;
    let requestPath;
    let responsePath;

    const cleanup = async () => {
      if (requestPath) await fs.unlink(requestPath).catch(() => {});
      if (responsePath) await fs.unlink(responsePath).catch(() => {});
    };

    try {
      await fs.mkdir(requestDir, { recursive: true, mode: 0o700 });
      requestId = crypto.randomBytes(16).toString("hex");
      requestPath = path.join(requestDir, `${requestId}.request.json`);
      responsePath = path.join(requestDir, `${requestId}.response.json`);

      const request = {
        requestId,
        requestedAt: new Date().toISOString(),
        timeoutMs: effectiveTimeout,
        capability: {
          id: capability.id,
          name: capability.name,
          risk: capability.risk,
          mode: capability.mode,
          description: capability.description,
        },
        invocation: {
          capabilityId: invocation.capabilityId,
          action: invocation.action,
          args: invocation.args,
          actorId: invocation.actorId,
          actorRole: invocation.actorRole,
        },
      };
      await fs.writeFile(requestPath, JSON.stringify(request, null, 2), {
        mode: 0o600,
      });
      if (onRequestWritten) await onRequestWritten(requestPath, requestId);
    } catch {
      await cleanup();
      return { approved: false, reason: "PROMPT_FAILED" };
    }

    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(responsePath, "utf8");
        let resp;
        try {
          resp = JSON.parse(raw);
        } catch {
          await cleanup();
          return { approved: false, reason: "PROMPT_FAILED" };
        }
        await cleanup();
        if (resp && resp.approved === true) {
          return {
            approved: true,
            reason: "USER_APPROVED",
            approvedBy:
              typeof resp.approvedBy === "string" && resp.approvedBy.length > 0
                ? resp.approvedBy
                : "file-approver",
          };
        }
        return { approved: false, reason: "USER_DENIED" };
      } catch (err) {
        if (err && err.code !== "ENOENT") {
          await cleanup();
          return { approved: false, reason: "PROMPT_FAILED" };
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    await cleanup();
    return { approved: false, reason: "TIMEOUT" };
  };
}

/**
 * webhookApprover — HTTP-based approval primitive, zero-dependency.
 *
 * Slack/Teams/PagerDuty/GitHub-Checks all share the same shape: notify
 * an external system, then wait for a callback that delivers the
 * approver's verdict. We intentionally do NOT bind an HTTP server inside
 * this package — that would force every caller to manage a port,
 * certificate, and reverse-proxy story. Instead the caller supplies:
 *
 *   - `notifyUrl`: where to POST the approval REQUEST (we sign it).
 *   - `secret`:    HMAC-SHA256 secret for the signature header.
 *   - `pollResponse(requestId)`: how to fetch the response. Returns
 *      `{ approved, approvedBy?, reason? }` when ready, or `null` when
 *      not yet ready. The approver polls this until response or timeout.
 *
 * Outbound headers on the notify POST:
 *   Content-Type: application/json
 *   X-Strix-Request-Id: <requestId>
 *   X-Strix-Signature: hmac-sha256=<hex(HMAC(secret, body))>
 *   X-Strix-Timestamp: <iso8601>
 *
 * The body is the same canonical JSON shape that fileApprover writes —
 * makes it trivial to relay one to the other.
 *
 * Why a poll function and not an inbound server: most production deploys
 * already have an inbound HTTP layer (Slack interaction handler, GitHub
 * webhook receiver, custom Express app). The caller's existing handler
 * persists `{requestId → response}` to whatever store it likes (Redis,
 * SQLite, in-memory map); `pollResponse` is a 4-line lookup against that
 * store. The gateway never owns a listening port.
 *
 * Hard rules (consistent with fileApprover / terminalApprove):
 *   - Default deny on timeout, parse error, or network error.
 *   - Approver errors fail closed.
 *   - Anything other than `approved === true` is a denial.
 *
 * @param {{
 *   notifyUrl: string,
 *   secret: string,
 *   pollResponse: (requestId: string) => Promise<null | { approved: boolean, approvedBy?: string, reason?: string }>,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   fetch?: typeof globalThis.fetch,
 * }} opts
 */
export function webhookApprover(opts) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("webhookApprover: opts is required");
  }
  if (typeof opts.notifyUrl !== "string" || !opts.notifyUrl) {
    throw new TypeError("webhookApprover: opts.notifyUrl is required");
  }
  if (typeof opts.secret !== "string" || opts.secret.length < 16) {
    throw new TypeError(
      "webhookApprover: opts.secret must be a string of at least 16 chars (HMAC-SHA256)",
    );
  }
  if (typeof opts.pollResponse !== "function") {
    throw new TypeError("webhookApprover: opts.pollResponse must be a function");
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const f = opts.fetch ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error(
      "webhookApprover: global fetch is unavailable — pass opts.fetch (Node 18+ has fetch built in)",
    );
  }

  return async function webhookApproverPrompt(capability, invocation, callOpts = {}) {
    const effectiveTimeout = callOpts.timeoutMs ?? timeoutMs;
    const requestId = crypto.randomBytes(16).toString("hex");
    const requestedAt = new Date().toISOString();
    const body = JSON.stringify({
      requestId,
      requestedAt,
      timeoutMs: effectiveTimeout,
      capability: {
        id: capability.id,
        name: capability.name,
        risk: capability.risk,
        mode: capability.mode,
        description: capability.description,
      },
      invocation: {
        capabilityId: invocation.capabilityId,
        action: invocation.action,
        args: invocation.args,
        actorId: invocation.actorId,
        actorRole: invocation.actorRole,
      },
    });
    const signature = crypto
      .createHmac("sha256", opts.secret)
      .update(body)
      .digest("hex");

    try {
      const res = await f(opts.notifyUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-strix-request-id": requestId,
          "x-strix-signature": `hmac-sha256=${signature}`,
          "x-strix-timestamp": requestedAt,
        },
        body,
      });
      if (!res.ok) {
        return { approved: false, reason: "PROMPT_FAILED" };
      }
    } catch {
      return { approved: false, reason: "PROMPT_FAILED" };
    }

    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await opts.pollResponse(requestId);
      } catch {
        return { approved: false, reason: "PROMPT_FAILED" };
      }
      if (resp && typeof resp === "object") {
        if (resp.approved === true) {
          return {
            approved: true,
            reason: "USER_APPROVED",
            approvedBy:
              typeof resp.approvedBy === "string" && resp.approvedBy
                ? resp.approvedBy
                : "webhook",
          };
        }
        return { approved: false, reason: "USER_DENIED" };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { approved: false, reason: "TIMEOUT" };
  };
}

/**
 * Verify the HMAC on an inbound request that was emitted by
 * `webhookApprover`. Provided so caller webhook receivers can authenticate
 * the gateway's POST without re-implementing the signature scheme.
 *
 * @param {{ body: string | Buffer, signatureHeader: string | undefined, secret: string }} args
 * @returns {boolean}
 */
export function verifyWebhookSignature({ body, signatureHeader, secret }) {
  // Always compute the HMAC before any early return so timing is
  // independent of the signature header format (prevents oracle attacks).
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const expected = crypto.createHmac("sha256", secret).update(bodyBuf).digest();

  if (typeof signatureHeader !== "string" || !signatureHeader) return false;
  const m = signatureHeader.match(/^hmac-sha256=([0-9a-f]{64})$/);
  if (!m) return false;
  const a = Buffer.from(m[1], "hex");
  return a.length === expected.length && crypto.timingSafeEqual(a, expected);
}

/**
 * No-op approver useful for tests. Always denies.
 *
 * @returns {Promise<import("./types.d.ts").ApprovalResult>}
 */
export async function alwaysDenyApprover() {
  return { approved: false, reason: "USER_DENIED" };
}

/**
 * Fixed-answer approver for tests / programmatic CI flows.
 *
 * @param {boolean} approve
 * @param {string} [approvedBy]
 */
export function fixedApprover(approve, approvedBy = "test") {
  return async () => ({
    approved: !!approve,
    reason: approve ? "USER_APPROVED" : "USER_DENIED",
    approvedBy: approve ? approvedBy : undefined,
  });
}

export { DEFAULT_TIMEOUT_MS };
