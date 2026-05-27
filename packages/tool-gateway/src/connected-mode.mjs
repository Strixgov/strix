/**
 * Connected mode — opt-in upstream sync.
 *
 * Local-first stays the default truth: every receipt is signed, chained,
 * and persisted locally before any sync attempt. Connected mode adds
 * fire-and-forget POSTs to a hosted endpoint so a fleet of agents can
 * roll their proof chains up to a central system. Failures NEVER block
 * local execution — the receipt is already in the on-disk chain.
 *
 *   Wire format:    v0.4-stable
 *   Method:         POST <kernelUrl>/<receiptsPath>
 *   Auth:           Authorization: Bearer <apiKey>
 *   Tenant:         X-Tenant-Id: <tenantId>
 *   Wire version:   X-Strix-Wire-Version: v0.4-stable
 *   Body signing:   X-Strix-Signature: hmac-sha256=<hex(HMAC(apiKey, body))>
 *   Body:           { wireVersion, timestamp, nonce, receipts: [<receipt>] }
 *
 * v0.4-stable replaces the v0.3-experimental envelope. The kernel must
 * validate timestamp freshness (recommended: reject if age > 5 min or
 * more than 30 s in the future) and enforce nonce uniqueness to prevent
 * replay attacks. The verifier's verifyConnectedWireEnvelope returns
 * `timestamp`, `nonce`, and `stale` to make this straightforward.
 *
 * Why HMAC over the body even though we already have the Ed25519
 * signature on every receipt: the body envelope is not itself signed by
 * the gateway's private key. The HMAC binds the envelope to the
 * API-key holder, so the kernel can authenticate the caller without
 * resolving the receipt's kid first.
 *
 * Failure semantics:
 *   - Network error / non-2xx: queue the receipt to an in-memory buffer
 *     (cap = 1000), emit `sync-error`. Next successful flush drains the
 *     buffer in order.
 *   - Buffer full: oldest entry is dropped (FIFO), `sync-error` fires
 *     with reason "buffer-overflow". Local chain is unaffected — the
 *     dropped record is still on disk.
 *   - apiKey missing in production: throws at construction. There is no
 *     "soft" connected mode.
 *
 * Events emitted on the gateway:
 *   - "sync"        — { receipt }                           on success
 *   - "sync-error"  — { receipt, err, reason, attempt }     on failure
 */

import crypto from "node:crypto";

export const WIRE_VERSION = "v0.4-stable";
const DEFAULT_RECEIPTS_PATH = "/api/v1/tool-gateway/receipts";
const DEFAULT_BUFFER_CAP = 1000;

/**
 * @typedef {{
 *   enabled?: boolean,
 *   kernelUrl: string,
 *   apiKey: string,
 *   tenantId: string,
 *   receiptsPath?: string,
 *   syncReceipts?: boolean,
 *   syncSnapshots?: boolean,
 *   bufferCap?: number,
 *   fetch?: typeof globalThis.fetch,
 *   onSyncError?: (e: { receipt?: object, snapshot?: object, err: Error, reason: string }) => void,
 * }} ConnectedModeOptions
 */

export class ConnectedSyncer {
  /**
   * @param {ConnectedModeOptions} opts
   */
  constructor(opts) {
    if (!opts || typeof opts !== "object") {
      throw new TypeError("ConnectedSyncer: options is required");
    }
    if (typeof opts.kernelUrl !== "string" || !opts.kernelUrl) {
      throw new TypeError("ConnectedSyncer: kernelUrl is required");
    }
    if (typeof opts.apiKey !== "string" || opts.apiKey.length < 16) {
      throw new TypeError(
        "ConnectedSyncer: apiKey must be a string of at least 16 chars",
      );
    }
    if (typeof opts.tenantId !== "string" || !opts.tenantId) {
      throw new TypeError("ConnectedSyncer: tenantId is required");
    }
    this.enabled = opts.enabled !== false;
    this.kernelUrl = opts.kernelUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.tenantId = opts.tenantId;
    this.receiptsPath = opts.receiptsPath ?? DEFAULT_RECEIPTS_PATH;
    this.syncReceipts = opts.syncReceipts !== false;
    this.syncSnapshots = opts.syncSnapshots !== false;
    this.bufferCap = opts.bufferCap ?? DEFAULT_BUFFER_CAP;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "ConnectedSyncer: global fetch unavailable — pass opts.fetch (Node 18+ has fetch built in)",
      );
    }
    this.onSyncError = opts.onSyncError;
    /** @type {Array<{ kind: "receipt" | "snapshot", record: object, attempts: number }>} */
    this._buffer = [];
    this._draining = false;
  }

  /**
   * @param {object} receipt
   * @returns {Promise<{ ok: boolean, status?: number, error?: Error }>}
   */
  async sendReceipt(receipt) {
    if (!this.enabled || !this.syncReceipts) return { ok: true };
    return this._send("receipt", receipt);
  }

  /**
   * @param {object} snapshot
   */
  async sendSnapshot(snapshot) {
    if (!this.enabled || !this.syncSnapshots) return { ok: true };
    return this._send("snapshot", snapshot);
  }

  /**
   * Build the signed wire body for one record. Each call produces a fresh
   * timestamp and nonce so replayed bodies are detectable by the kernel.
   */
  _buildBody(kind, record) {
    const envelope = {
      wireVersion: WIRE_VERSION,
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString("hex"),
      [kind === "receipt" ? "receipts" : "snapshots"]: [record],
    };
    const body = JSON.stringify(envelope);
    const signature = crypto
      .createHmac("sha256", this.apiKey)
      .update(body)
      .digest("hex");
    return { body, signature };
  }

  async _send(kind, record) {
    const { body, signature } = this._buildBody(kind, record);
    const url =
      kind === "receipt"
        ? `${this.kernelUrl}${this.receiptsPath}`
        : `${this.kernelUrl}${this.receiptsPath.replace(/receipts$/, "snapshots")}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-tenant-id": this.tenantId,
          "x-strix-wire-version": WIRE_VERSION,
          "x-strix-signature": `hmac-sha256=${signature}`,
        },
        body,
      });
      if (!res.ok) {
        const err = new Error(`upstream ${res.status}`);
        this._enqueue(kind, record, "non-2xx");
        return { ok: false, status: res.status, error: err };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      this._enqueue(kind, record, "network-error");
      return { ok: false, error: err };
    }
  }

  _enqueue(kind, record, reason) {
    if (this._buffer.length >= this.bufferCap) {
      const dropped = this._buffer.shift();
      this._emitSyncError({
        [dropped.kind === "receipt" ? "receipt" : "snapshot"]: dropped.record,
        err: new Error("buffer overflow — oldest record dropped"),
        reason: "buffer-overflow",
      });
    }
    this._buffer.push({ kind, record, attempts: 0 });
    this._emitSyncError({
      [kind === "receipt" ? "receipt" : "snapshot"]: record,
      err: new Error(`sync deferred: ${reason}`),
      reason,
    });
  }

  /**
   * Drain queued records best-effort. Caller-driven so the gateway can
   * tie the cadence to its own scheduling (e.g. on the next receipt
   * issued, on a timer, on demand from the CLI).
   */
  async drain() {
    if (this._draining || this._buffer.length === 0) return { drained: 0 };
    this._draining = true;
    let drained = 0;
    try {
      while (this._buffer.length > 0) {
        const head = this._buffer[0];
        head.attempts += 1;
        const res = await this._sendInner(head.kind, head.record);
        if (!res.ok) break;
        this._buffer.shift();
        drained += 1;
      }
    } finally {
      this._draining = false;
    }
    return { drained };
  }

  async _sendInner(kind, record) {
    // Same as _send but doesn't re-enqueue on failure (drain owns that loop).
    const { body, signature } = this._buildBody(kind, record);
    const url =
      kind === "receipt"
        ? `${this.kernelUrl}${this.receiptsPath}`
        : `${this.kernelUrl}${this.receiptsPath.replace(/receipts$/, "snapshots")}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-tenant-id": this.tenantId,
          "x-strix-wire-version": WIRE_VERSION,
          "x-strix-signature": `hmac-sha256=${signature}`,
        },
        body,
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  _emitSyncError(payload) {
    // Defer via queueMicrotask so observer work does not block the call
    // path that produced the error (receipt persist, buffer update, etc.).
    queueMicrotask(() => {
      if (typeof this.onSyncError === "function") {
        try {
          this.onSyncError(payload);
        } catch {
          /* observer error never poisons the syncer */
        }
      }
    });
  }

  /** Number of records waiting to be drained. */
  get pending() {
    return this._buffer.length;
  }
}
