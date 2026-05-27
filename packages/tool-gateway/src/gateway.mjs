/**
 * Gateway — the inline execution control point.
 *
 * Agent → Gateway.execute(invocation, executor) → Tool
 *
 * Order of operations is load-bearing:
 *
 *   1. Validate invocation + capability classification
 *   2. PolicyEngine.evaluate                 (deterministic)
 *   3. Emit "decision"                        (post-eval, pre-approval)
 *   4. If APPROVAL_REQUIRED: prompt + wait    (deny on timeout)
 *   5. Issue receipt with the FINAL decision  (signed, chained,
 *                                              policyVersion-bound)
 *   6. Persist receipt under the chain mutex
 *   7. Emit "receipt" + ("denial" if denied)
 *   8. ONLY THEN, if decision === ALLOW, invoke the executor
 *   9. Emit "error" if the executor throws (receipt already in chain)
 *
 * Step 6 happens before step 8: a denied or approval-failed action
 * still leaves a signed receipt in the chain. There is no "executed
 * but undocumented" state.
 *
 * Events (EventEmitter — listeners are called synchronously, MUST NOT
 * throw or block; if they do, the gateway logs and continues):
 *
 *   "decision" → { evaluation, invocation }       — after policy eval
 *   "receipt"  → receipt                          — after persist (always)
 *   "denial"   → { receipt, evaluation, approval } — only on DENY
 *   "error"    → { receipt, err, invocation }     — executor threw
 */

import { EventEmitter } from "node:events";
import { PolicyEngine } from "./policy.mjs";
import { issueReceipt, GENESIS_PROOF_CHAIN_HASH } from "./receipts.mjs";
import { terminalApprove } from "./approval.mjs";
import { issueSnapshot } from "./snapshots.mjs";
import { RateLimiter } from "./rate-limit.mjs";
import { ConnectedSyncer } from "./connected-mode.mjs";

export class Gateway extends EventEmitter {
  /**
   * @param {import("./types.d.ts").GatewayOptions} options
   */
  constructor(options) {
    super();
    if (!options) throw new Error("Gateway: options is required");
    if (!options.signingKey && !options.keyRing) {
      throw new Error("Gateway: signingKey or keyRing is required (fail-closed)");
    }
    if (!options.storage) throw new Error("Gateway: storage is required");
    if (!options.policy) throw new Error("Gateway: policy is required");

    this.keyRing = options.keyRing ?? null;
    this.signingKey = options.signingKey ?? options.keyRing?.active;
    if (!this.signingKey) {
      throw new Error("Gateway: keyRing has no active signing key");
    }
    this.storage = options.storage;
    this.toolName = options.toolName ?? "strix-gateway";
    this.tenantId = options.tenantId ?? "local";
    this.environment = options.environment ?? "local";
    this.policyEngine = new PolicyEngine(
      options.policy,
      { ...(options.capabilities ?? {}) }
    );

    this.rateLimiter = options.rateLimiter ?? new RateLimiter(options.policy?.rateLimits ?? {});

    /** @type {ConnectedSyncer | null} */
    this.connectedSyncer = null;
    if (options.connectedMode && options.connectedMode.enabled !== false) {
      this.connectedSyncer = new ConnectedSyncer({
        ...options.connectedMode,
        tenantId: options.connectedMode.tenantId ?? this.tenantId,
        onSyncError: (e) => {
          this._safeEmit("sync-error", e);
          if (typeof options.connectedMode.onSyncError === "function") {
            try {
              options.connectedMode.onSyncError(e);
            } catch {
              /* observer error never poisons the gateway */
            }
          }
        },
      });
    }

    /** @type {{ threshold: number, windowMs: number, decisions: import("./types.d.ts").Decision[], onEscalate?: (e: object) => void } | null} */
    this.escalation = null;
    if (options.escalation) {
      const e = options.escalation;
      if (typeof e.threshold !== "number" || e.threshold <= 0) {
        throw new TypeError("Gateway: escalation.threshold must be > 0");
      }
      if (typeof e.windowMs !== "number" || e.windowMs <= 0) {
        throw new TypeError("Gateway: escalation.windowMs must be > 0");
      }
      this.escalation = {
        threshold: e.threshold,
        windowMs: e.windowMs,
        decisions: e.decisions ?? ["DENY"],
        onEscalate: e.onEscalate,
      };
      /** @type {Array<{ at: number, receipt: import("./types.d.ts").Receipt }>} */
      this._escalationLog = [];
    }

    const ap = options.approval ?? {};
    this.approval = {
      enabled: ap.enabled !== false,
      timeoutMs: ap.timeoutMs ?? 60_000,
      autoApprove: ap.autoApprove === true,
      prompt: ap.prompt ?? terminalApprove,
    };

    /** Serializes the read-prev → issue → append cycle. */
    this._chainLock = Promise.resolve();

    // EventEmitter-default behaviour throws on an unhandled "error"
    // event. We don't want a missing observer to crash the process —
    // the gateway already records the failure in the receipt and
    // returns it through `execute`. Set max listeners to a sane high
    // value too (one app may attach metrics + audit + alert observers).
    this.setMaxListeners(50);
    this.on("error", () => {
      /* swallow if no other handler is attached */
    });
  }

  /** Content-addressable hash of the active policy ruleset. */
  get policyVersion() {
    return this.policyEngine.version;
  }

  /**
   * @param {import("./types.d.ts").ToolCapability} capability
   */
  registerCapability(capability) {
    this.policyEngine.registerCapability(capability);
  }

  /**
   * @param {import("./types.d.ts").PolicyRuleset} rules
   */
  setPolicy(rules) {
    this.policyEngine.setRuleset(rules);
  }

  /**
   * @param {import("./types.d.ts").ToolInvocation} invocation
   */
  evaluate(invocation) {
    return this.policyEngine.evaluate(invocation);
  }

  async listReceipts() {
    return this.storage.listReceipts();
  }

  /**
   * Track a receipt in the escalation sliding window and fire
   * `escalation` if the threshold is breached. The escalation hook is a
   * runtime observability pattern — it does NOT alter the receipt or
   * the policy decision.
   *
   * @param {import("./types.d.ts").Receipt} receipt
   */
  _recordForEscalation(receipt) {
    if (!this.escalation) return;
    if (!this.escalation.decisions.includes(receipt.decision)) return;
    const now = Date.now();
    const cutoff = now - this.escalation.windowMs;
    this._escalationLog = this._escalationLog.filter((e) => e.at >= cutoff);
    this._escalationLog.push({ at: now, receipt });
    if (this._escalationLog.length >= this.escalation.threshold) {
      const event = {
        threshold: this.escalation.threshold,
        windowMs: this.escalation.windowMs,
        count: this._escalationLog.length,
        receipts: this._escalationLog.map((e) => e.receipt),
      };
      // Reset the window so we don't fire continuously while still over
      // threshold. Caller decides if a follow-up burst is its own event.
      this._escalationLog = [];
      try {
        if (this.escalation.onEscalate) this.escalation.onEscalate(event);
      } catch {
        /* observer error never poisons the gateway */
      }
      this._safeEmit("escalation", event);
    }
  }

  /**
   * Emit an event without letting listener errors propagate. The gateway
   * is on the hot path of an agent's tool call — a buggy observer must
   * not poison the receipt-issuance flow.
   *
   * @param {string} event
   * @param {...unknown} args
   */
  _safeEmit(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch {
      /* swallow — observer error is not load-bearing for governance */
    }
  }

  /**
   * Record a synthetic DENY without consulting the policy engine. This
   * is the escape hatch adapters need for hardfail-class checks (e.g.
   * the shell adapter's `rm -rf /` pattern list): the *adapter*
   * authoritatively denies, the gateway just mints + chains the
   * receipt. Used sparingly; do NOT use this to ALLOW past policy.
   *
   * @param {{
   *   invocation: import("./types.d.ts").ToolInvocation,
   *   capability: import("./types.d.ts").ToolCapability,
   *   reason: string,
   * }} args
   * @returns {Promise<import("./types.d.ts").Receipt>}
   */
  async recordDenial(args) {
    const prev = this._chainLock;
    let release;
    this._chainLock = new Promise((r) => (release = r));
    let receipt;
    try {
      await prev;
      const last = await this.storage.lastReceipt();
      const previousChainHash = last?.proofChainHash ?? GENESIS_PROOF_CHAIN_HASH;
      receipt = issueReceipt({
        invocation: args.invocation,
        capability: args.capability,
        decision: "DENY",
        previousChainHash,
        signingKey: this.signingKey,
        toolName: this.toolName,
        approval: { approved: false, reason: "USER_DENIED" },
        policyVersion: this.policyVersion,
        tenantId: this.tenantId,
        environment: this.environment,
      });
      receipt.approvalReason = "USER_DENIED";
      receipt.tool = this.toolName;
      // @ts-expect-error attach a non-canonical reason field
      receipt.denialReason = args.reason;
      await this.storage.appendReceipt(receipt);
    } finally {
      release();
    }
    this._safeEmit("receipt", receipt);
    this._safeEmit("denial", { receipt, reason: args.reason, hardfail: true });
    return receipt;
  }

  /**
   * Rotate the active signing key and write a cross-signed snapshot.
   *
   * The snapshot records the kid handoff under the receipt-chain mutex,
   * so no concurrent execute() can slip a receipt between the last
   * receipt-under-old-kid and the snapshot record. New receipts after
   * `rotateKey` returns are signed by the new active key.
   *
   * Requires a `keyRing` option to have been passed at construction.
   *
   * @param {{ kid?: string }} [opts]
   */
  async rotateKey(opts = {}) {
    if (!this.keyRing) {
      throw new Error(
        "Gateway.rotateKey: a keyRing must be supplied at construction time",
      );
    }
    const prev = this._chainLock;
    let release;
    this._chainLock = new Promise((r) => (release = r));
    let snapshot;
    try {
      await prev;
      const last = await this.storage.lastReceipt();
      if (!last) {
        throw new Error(
          "Gateway.rotateKey: cannot rotate before any receipts exist (genesis chain)",
        );
      }
      const previousKey = this.signingKey;
      const { current } = await this.keyRing.rotate(opts);
      const newKey = {
        kid: current.kid,
        privateKey: current.privateKey,
        publicKey: current.publicKey,
        publicKeyJwk: current.publicKeyJwk,
      };
      snapshot = issueSnapshot({
        previousKey,
        newKey,
        lastReceiptId: last.receiptId,
        lastProofChainHash: last.proofChainHash,
        policyVersion: this.policyVersion,
        tenantId: this.tenantId,
        environment: this.environment,
      });
      await this.storage.appendSnapshot(snapshot);
      this.signingKey = newKey;
    } finally {
      release();
    }
    this._safeEmit("rotation", { snapshot });
    this._fireAndForgetSync("snapshot", snapshot);
    return snapshot;
  }

  /**
   * Fire-and-forget upstream sync. Never throws; failures are queued in
   * the syncer's buffer and surfaced via the `sync-error` event. Local
   * execution path is unaffected by upstream availability.
   *
   * @param {"receipt" | "snapshot"} kind
   * @param {object} record
   */
  _fireAndForgetSync(kind, record) {
    if (!this.connectedSyncer) return;
    const send =
      kind === "receipt"
        ? () => this.connectedSyncer.sendReceipt(record)
        : () => this.connectedSyncer.sendSnapshot(record);
    Promise.resolve()
      .then(send)
      .then((res) => {
        if (res?.ok) this._safeEmit("sync", { kind, record });
      })
      .catch(() => {
        /* errors already routed via onSyncError → "sync-error" event */
      });
  }

  /**
   * Best-effort drain of any queued upstream sync. Caller-driven so the
   * gateway can tie cadence to its own scheduling. No-op when connected
   * mode is disabled.
   */
  async drainSync() {
    if (!this.connectedSyncer) return { drained: 0, pending: 0 };
    const result = await this.connectedSyncer.drain();
    return { ...result, pending: this.connectedSyncer.pending };
  }

  /**
   * Replace the active rate-limit ruleset. Does not affect the policy
   * version hash — rate limits are advisory at the gateway boundary, not
   * part of the deterministic policy decision. Pass an empty object to
   * disable.
   *
   * @param {Record<string, { windowMs: number, max: number, perActor?: boolean }>} rules
   */
  setRateLimits(rules) {
    this.rateLimiter = new RateLimiter(rules ?? {});
  }

  /**
   * Walk the receipt chain and verify each link's proofChainHash points
   * at the previous record. Returns `{valid:true}` for an empty chain.
   * Does NOT verify Ed25519 signatures — use @strixgov/verifier or
   * verifyReceipt() for that.
   */
  async verifyChain() {
    const all = await this.storage.listReceipts();
    let prev = GENESIS_PROOF_CHAIN_HASH;
    const crypto = await import("node:crypto");
    for (const r of all) {
      const expected = crypto
        .createHash("sha256")
        .update(`${prev}|${r.evidenceHash}`)
        .digest("hex");
      if (expected !== r.proofChainHash) {
        return { valid: false, brokenAt: r.receiptId };
      }
      prev = r.proofChainHash;
    }
    return { valid: true };
  }

  /**
   * Governed execution.
   *
   * @template TArgs
   * @template TResult
   * @param {import("./types.d.ts").ToolInvocation} invocation
   * @param {(args: TArgs) => Promise<TResult> | TResult} executor
   * @returns {Promise<import("./types.d.ts").ExecuteResult<TResult>>}
   */
  async execute(invocation, executor) {
    if (!invocation || typeof invocation.capabilityId !== "string") {
      throw new TypeError("Gateway.execute: invocation.capabilityId is required");
    }
    if (typeof executor !== "function") {
      throw new TypeError("Gateway.execute: executor must be a function");
    }

    const evaluation = this.policyEngine.evaluate(invocation);
    const cap =
      this.policyEngine.capabilities[invocation.capabilityId] ??
      // Synthesize a fail-closed capability so we can still mint a
      // signed receipt for an unknown-capability denial.
      {
        id: invocation.capabilityId,
        risk: "CRITICAL",
        mode: "EXECUTE",
      };

    this._safeEmit("decision", { evaluation, invocation });

    let finalDecision = evaluation.decision;
    /** @type {import("./types.d.ts").ApprovalResult | undefined} */
    let approval;
    /** @type {string | null} */
    let rateLimitReason = null;

    // Rate-limit BEFORE approval. A capability under a per-second cap
    // should not consume an operator's attention with a y/N prompt only
    // to deny on quota — that's worse UX than denying up front.
    if (finalDecision !== "DENY") {
      const rl = this.rateLimiter.check({
        capabilityId: invocation.capabilityId,
        actorId: invocation.actorId,
      });
      if (!rl.allowed) {
        finalDecision = "DENY";
        rateLimitReason = rl.reason ?? "RATE_LIMITED";
      }
    }

    if (finalDecision === "APPROVAL_REQUIRED") {
      if (!this.approval.enabled) {
        finalDecision = "DENY";
        approval = { approved: false, reason: "PROMPT_FAILED" };
      } else if (this.approval.autoApprove) {
        finalDecision = "ALLOW";
        approval = {
          approved: true,
          reason: "USER_APPROVED",
          approvedBy: "auto-approve",
        };
      } else {
        try {
          approval = await this.approval.prompt(cap, invocation, {
            timeoutMs: this.approval.timeoutMs,
          });
        } catch (err) {
          approval = { approved: false, reason: "PROMPT_FAILED" };
        }
        finalDecision = approval.approved ? "ALLOW" : "DENY";
      }
    }

    // Critical section: read previous chain hash, mint, append. Holding
    // the lock keeps two concurrent execute() calls from forking the
    // chain at the same point.
    const prev = this._chainLock;
    let release;
    this._chainLock = new Promise((r) => (release = r));
    let receipt;
    try {
      await prev;
      const last = await this.storage.lastReceipt();
      const previousChainHash = last?.proofChainHash ?? GENESIS_PROOF_CHAIN_HASH;
      receipt = issueReceipt({
        invocation,
        capability: cap,
        decision: finalDecision,
        previousChainHash,
        signingKey: this.signingKey,
        toolName: this.toolName,
        approval,
        policyVersion: this.policyVersion,
        tenantId: this.tenantId,
        environment: this.environment,
      });
      await this.storage.appendReceipt(receipt);
    } finally {
      release();
    }

    if (rateLimitReason) {
      // Side-channel for non-canonical metadata. Not part of the signed
      // payload — the receipt is already a DENY and the policyVersion
      // captures what would have been allowed.
      // @ts-expect-error attach a non-canonical reason field
      receipt.denialReason = rateLimitReason;
    }

    this._safeEmit("receipt", receipt);
    if (finalDecision === "DENY") {
      this._safeEmit("denial", {
        receipt,
        evaluation,
        approval,
        rateLimited: !!rateLimitReason,
      });
    }
    this._recordForEscalation(receipt);
    this._fireAndForgetSync("receipt", receipt);

    if (finalDecision !== "ALLOW") {
      return {
        ok: false,
        decision: finalDecision,
        receipt,
        error: {
          code: rateLimitReason || evaluation.reason || "DENIED",
          message: rateLimitReason
            ? `Execution rate-limited (${rateLimitReason})`
            : `Execution denied (rule: ${evaluation.matchedRule}, risk: ${cap.risk})`,
        },
      };
    }

    try {
      const result = await executor(invocation.args);
      return { ok: true, decision: "ALLOW", receipt, result };
    } catch (err) {
      this._safeEmit("error", { receipt, err, invocation });
      return {
        ok: false,
        decision: "ALLOW",
        receipt,
        error: {
          code: "EXECUTOR_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * @param {import("./types.d.ts").GatewayOptions} options
 * @returns {Gateway}
 */
export function createGateway(options) {
  return new Gateway(options);
}
