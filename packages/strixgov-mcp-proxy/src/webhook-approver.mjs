/**
 * Webhook approval channel — Slack-compatible notification on top of the
 * gateway's file approver.
 *
 * Design (deliberate): the tool-gateway `fileApprover` is the headless
 * approval PRIMITIVE — request file written, response file awaited,
 * timeout → DENY. Its contract explicitly says network adapters belong
 * ON TOP of that primitive, not inside it. This module is that adapter:
 *
 *   1. fileApprover writes `<requestId>.request.json` as always.
 *   2. `onRequestWritten` fires a POST to `webhookUrl` with a
 *      Slack-incoming-webhook-compatible body (`{ text }`) plus a
 *      structured `strix` block for non-Slack consumers.
 *   3. The DECISION still arrives as the response file — written by a
 *      human via `npx @strixgov/guard approve <requestId>`, a Slack
 *      workflow, a bot, or any out-of-band channel.
 *
 * Failure semantics (load-bearing):
 *   - Notification failure NEVER approves and NEVER auto-denies. The
 *     request file is already on disk; the approver keeps waiting and
 *     the existing timeout → DENY applies. A lost Slack message must
 *     not silently deny a legitimate call, and must never allow one.
 *   - Missing/invalid `webhookUrl` fails at STARTUP (config error),
 *     not at first call — an operator can't misconfigure silently
 *     into a notification-less loop.
 *
 * No new dependency: uses global fetch (Node >= 18).
 */

import { fileApprover } from "@strixgov/tool-gateway";

/** Max characters of the args preview embedded in the notification. */
const ARGS_PREVIEW_MAX = 240;

/**
 * Build the Slack-compatible notification body for a pending approval.
 * Exported for tests (pure).
 *
 * @param {{ requestId: string, serverId?: string, capability: object, invocation: object }} req
 * @returns {{ text: string, strix: object }}
 */
export function buildWebhookPayload(req) {
  const cap = req.capability ?? {};
  const inv = req.invocation ?? {};
  let argsPreview = "<none>";
  if (inv.args !== undefined && inv.args !== null) {
    try {
      const s = JSON.stringify(inv.args);
      argsPreview = s.length > ARGS_PREVIEW_MAX ? `${s.slice(0, ARGS_PREVIEW_MAX - 3)}...` : s;
    } catch {
      argsPreview = "<unserializable>";
    }
  }
  const lines = [
    ":shield: *Strix approval required*",
    `*Server:* ${req.serverId ?? "unknown"}`,
    `*Capability:* ${cap.id ?? inv.capabilityId ?? "unknown"} (risk: ${cap.risk ?? "unknown"})`,
    `*Action:* ${inv.action ?? "unknown"}`,
    `*Args:* \`${argsPreview}\``,
    `*Request:* \`${req.requestId}\``,
    "",
    `Approve: \`npx @strixgov/guard approve ${req.requestId}\``,
    `Deny:    \`npx @strixgov/guard deny ${req.requestId}\``,
  ];
  return {
    text: lines.join("\n"),
    // Structured mirror for non-Slack webhook consumers (Slack ignores
    // unknown top-level keys). Contains no more than the request file does.
    strix: {
      kind: "approval.requested",
      requestId: req.requestId,
      serverId: req.serverId,
      capabilityId: cap.id ?? inv.capabilityId,
      risk: cap.risk,
      action: inv.action,
    },
  };
}

/**
 * Construct the webhook approver prompt function.
 *
 * @param {{
 *   webhookUrl: string,
 *   serverId?: string,
 *   requestDir: string,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   onAudit?: (event: { kind: string, detail: object }) => void,
 *   fetchImpl?: typeof fetch,   // test seam only
 * }} opts
 */
export function webhookApprover(opts) {
  const { webhookUrl } = opts ?? {};
  if (typeof webhookUrl !== "string" || webhookUrl.length === 0) {
    throw new Error(
      'webhookApprover: approval.type "webhook" requires approval.webhookUrl',
    );
  }
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error(`webhookApprover: approval.webhookUrl is not a valid URL: '${webhookUrl}'`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `webhookApprover: approval.webhookUrl must be http(s), got '${parsed.protocol}'`,
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const audit = (event) => {
    if (typeof opts.onAudit === "function") {
      try { opts.onAudit(event); } catch { /* never let audit break approval */ }
    }
  };

  let pendingRequest = null;
  const inner = fileApprover({
    requestDir: opts.requestDir,
    timeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
    onRequestWritten: async (_requestPath, requestId) => {
      const payload = buildWebhookPayload({ ...pendingRequest, requestId });
      try {
        const res = await doFetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          audit({ kind: "approval.webhook.notified", detail: { requestId, status: res.status } });
        } else {
          audit({
            kind: "approval.webhook.notify_failed",
            detail: { requestId, status: res.status },
          });
        }
      } catch (err) {
        // Best-effort notification: the request file is the source of
        // truth; the decision path (response file / timeout DENY) is
        // unaffected by a lost notification.
        audit({
          kind: "approval.webhook.notify_failed",
          detail: { requestId, error: err?.message ?? String(err) },
        });
      }
    },
  });

  return async function webhookApproverPrompt(capability, invocation, callOpts) {
    pendingRequest = { serverId: opts.serverId, capability, invocation };
    try {
      return await inner(capability, invocation, callOpts);
    } finally {
      pendingRequest = null;
    }
  };
}
