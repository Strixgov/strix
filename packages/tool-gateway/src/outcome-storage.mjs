import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expandTilde } from "./paths.mjs";

const DEFAULT_OUTCOME_STORAGE_DIR = path.join(os.homedir(), ".strix-gateway");
const OUTCOMES_FILE = "execution-outcomes.jsonl";

/** Append-only JSONL store for signed post-execution outcome records. */
export class JsonlOutcomeStorage {
  constructor(opts = {}) {
    this.dir = expandTilde(opts.dir ?? DEFAULT_OUTCOME_STORAGE_DIR);
    this.file = path.join(this.dir, opts.file ?? OUTCOMES_FILE);
    this._writeLock = Promise.resolve();
    this._initialized = false;
  }

  async _init() {
    if (this._initialized) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.access(this.file);
    } catch {
      await fs.writeFile(this.file, "", { mode: 0o600 });
    }
    this._initialized = true;
  }

  async appendOutcome(outcome) {
    await this._init();
    const line = JSON.stringify(outcome) + "\n";
    const prev = this._writeLock;
    let release;
    this._writeLock = new Promise((resolve) => (release = resolve));
    try {
      await prev;
      await fs.appendFile(this.file, line, { mode: 0o600 });
    } finally {
      release();
    }
  }

  async listOutcomes() {
    await this._init();
    const raw = await fs.readFile(this.file, "utf8");
    if (!raw) return [];
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        throw new Error(
          `JsonlOutcomeStorage: corrupt outcome line in ${this.file}: ${line.slice(0, 80)}…`,
        );
      }
    }
    return out;
  }

  async getOutcome(outcomeId) {
    const all = await this.listOutcomes();
    return all.find((outcome) => outcome.outcomeId === outcomeId) ?? null;
  }

  async lastOutcome() {
    const all = await this.listOutcomes();
    return all.length === 0 ? null : all[all.length - 1];
  }
}

export class MemoryOutcomeStorage {
  constructor() {
    this._outcomes = [];
  }

  async appendOutcome(outcome) {
    this._outcomes.push(outcome);
  }

  async listOutcomes() {
    return this._outcomes.slice();
  }

  async getOutcome(outcomeId) {
    return this._outcomes.find((outcome) => outcome.outcomeId === outcomeId) ?? null;
  }

  async lastOutcome() {
    return this._outcomes[this._outcomes.length - 1] ?? null;
  }
}

export { DEFAULT_OUTCOME_STORAGE_DIR, OUTCOMES_FILE };
