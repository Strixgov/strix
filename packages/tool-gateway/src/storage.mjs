/**
 * Append-only JSONL receipt store.
 *
 * Why JSONL not SQLite: the v1 surface needs to be auditable by `cat`,
 * `grep`, and `tail -f` from a developer's terminal. The receipt chain
 * is the proof; the storage format is just a transcript. Anyone with
 * file-read access can re-verify offline with @strixgov/verifier.
 *
 * Concurrency: appendReceipt is async-serialized through a per-instance
 * mutex so two concurrent callers can never observe the same
 * `lastReceipt()` and append a duplicate proof-chain link.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expandTilde } from "./paths.mjs";

const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".strix-gateway");
const RECEIPTS_FILE = "receipts.jsonl";
const SNAPSHOTS_FILE = "snapshots.jsonl";

/**
 * @implements {import("./types.d.ts").StorageDriver}
 */
export class JsonlStorage {
  /**
   * @param {{ dir?: string, file?: string, snapshotsFile?: string }} [opts]
   */
  constructor(opts = {}) {
    this.dir = expandTilde(opts.dir ?? DEFAULT_STORAGE_DIR);
    this.file = path.join(this.dir, opts.file ?? RECEIPTS_FILE);
    this.snapshotsFile = path.join(
      this.dir,
      opts.snapshotsFile ?? SNAPSHOTS_FILE,
    );
    /** @type {Promise<void>} */
    this._writeLock = Promise.resolve();
    this._snapshotLock = Promise.resolve();
    this._initialized = false;
  }

  async _init() {
    if (this._initialized) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const f of [this.file, this.snapshotsFile]) {
      try {
        await fs.access(f);
      } catch {
        await fs.writeFile(f, "", { mode: 0o600 });
      }
    }
    this._initialized = true;
  }

  /**
   * @param {import("./types.d.ts").Receipt} receipt
   */
  async appendReceipt(receipt) {
    await this._init();
    const line = JSON.stringify(receipt) + "\n";
    // Serialize writes — guarantees that the file order matches the
    // proof-chain link order even under concurrent execute() calls.
    const prev = this._writeLock;
    let release;
    this._writeLock = new Promise((r) => (release = r));
    try {
      await prev;
      await fs.appendFile(this.file, line, { mode: 0o600 });
    } finally {
      release();
    }
  }

  async lastReceipt() {
    const all = await this.listReceipts();
    return all.length === 0 ? null : all[all.length - 1];
  }

  async listReceipts() {
    await this._init();
    const raw = await fs.readFile(this.file, "utf8");
    if (!raw) return [];
    /** @type {import("./types.d.ts").Receipt[]} */
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Tampered/corrupt line. Don't silently drop — surface upstream.
        throw new Error(
          `JsonlStorage: corrupt receipt line in ${this.file}: ${line.slice(0, 80)}…`
        );
      }
    }
    return out;
  }

  /**
   * @param {string} receiptId
   */
  async getReceipt(receiptId) {
    const all = await this.listReceipts();
    return all.find((r) => r.receiptId === receiptId) ?? null;
  }

  /**
   * Append a chain snapshot to the parallel snapshots.jsonl. Snapshots are
   * cross-signed key-rotation boundary markers; the receipt chain itself
   * is unaffected by their presence.
   *
   * @param {object} snapshot
   */
  async appendSnapshot(snapshot) {
    await this._init();
    const line = JSON.stringify(snapshot) + "\n";
    const prev = this._snapshotLock;
    let release;
    this._snapshotLock = new Promise((r) => (release = r));
    try {
      await prev;
      await fs.appendFile(this.snapshotsFile, line, { mode: 0o600 });
    } finally {
      release();
    }
  }

  async listSnapshots() {
    await this._init();
    const raw = await fs.readFile(this.snapshotsFile, "utf8");
    if (!raw) return [];
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        throw new Error(
          `JsonlStorage: corrupt snapshot line in ${this.snapshotsFile}: ${line.slice(0, 80)}…`,
        );
      }
    }
    return out;
  }
}

/**
 * In-memory store. Useful for tests; never use in production — receipts
 * are lost on process exit, defeating the proof chain.
 *
 * @implements {import("./types.d.ts").StorageDriver}
 */
export class MemoryStorage {
  constructor() {
    /** @type {import("./types.d.ts").Receipt[]} */
    this._receipts = [];
  }

  async appendReceipt(receipt) {
    this._receipts.push(receipt);
  }

  async lastReceipt() {
    return this._receipts[this._receipts.length - 1] ?? null;
  }

  async listReceipts() {
    return this._receipts.slice();
  }

  async getReceipt(receiptId) {
    return this._receipts.find((r) => r.receiptId === receiptId) ?? null;
  }

  async appendSnapshot(snapshot) {
    if (!this._snapshots) this._snapshots = [];
    this._snapshots.push(snapshot);
  }

  async listSnapshots() {
    return (this._snapshots ?? []).slice();
  }
}

export { DEFAULT_STORAGE_DIR };
