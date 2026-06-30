/**
 * Evidence Layer — Immutable Execution Records
 *
 * Every governed action execution (whether successful or blocked)
 * generates a signed, append-only ExecutionRecord. These records
 * form the tamper-evident audit trail required for SOC2, GDPR, and
 * HIPAA compliance.
 */

import { randomUUID } from "node:crypto";
import { sha256 } from "../token/sdt.js";
import type { ExecutionRecord, EvidenceSink, EvidenceSinkConfig } from "../types.js";

// ─── Record Construction ────────────────────────────────────────────

/**
 * Build an ExecutionRecord with a computed integrity hash.
 */
export function buildExecutionRecord(
  params: Omit<ExecutionRecord, "executionId" | "recordHash" | "timestamp">
): ExecutionRecord {
  const executionId = `exec_${randomUUID().replace(/-/g, "")}`;
  const timestamp = new Date().toISOString();

  // Build the record without the hash first
  const record: ExecutionRecord = {
    executionId,
    timestamp,
    recordHash: "", // placeholder
    ...params,
  };

  // Compute the integrity hash over the canonical record
  record.recordHash = computeRecordHash(record);

  return record;
}

/**
 * Compute the SHA-256 hash of an execution record for tamper detection.
 * The hash is computed over a deterministic JSON representation,
 * excluding the recordHash field itself.
 */
export function computeRecordHash(record: ExecutionRecord): string {
  const { recordHash: _, ...hashable } = record;
  const canonical = JSON.stringify(hashable, Object.keys(hashable).sort());
  return `sha256:${sha256(canonical)}`;
}

/**
 * Verify that an execution record's hash is valid (not tampered).
 */
export function verifyRecordIntegrity(record: ExecutionRecord): boolean {
  const expected = computeRecordHash(record);
  return record.recordHash === expected;
}

// ─── Evidence Sinks ─────────────────────────────────────────────────

/**
 * In-memory evidence sink for testing and development.
 */
export class MemoryEvidenceSink implements EvidenceSink {
  private records: ExecutionRecord[] = [];

  async write(record: ExecutionRecord): Promise<void> {
    this.records.push(record);
  }

  async read(capabilityId: string): Promise<ExecutionRecord[]> {
    return this.records.filter((r) => r.capabilityId === capabilityId);
  }

  /** Get all records (testing utility) */
  getAll(): ExecutionRecord[] {
    return [...this.records];
  }

  /** Clear all records (testing utility) */
  clear(): void {
    this.records = [];
  }
}

/**
 * File-based evidence sink — append-only JSON lines.
 * Each record is written as a single line of JSON to an append-only file.
 */
export class FileEvidenceSink implements EvidenceSink {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async write(record: ExecutionRecord): Promise<void> {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf-8");
  }

  async read(capabilityId: string): Promise<ExecutionRecord[]> {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    if (!existsSync(this.filePath)) {
      return [];
    }

    const contents = await readFile(this.filePath, "utf-8");
    const lines = contents.split("\n").filter((line) => line.trim().length > 0);

    return lines
      .map((line) => JSON.parse(line) as ExecutionRecord)
      .filter((r) => r.capabilityId === capabilityId);
  }
}

/**
 * Create an evidence sink from configuration.
 */
export function createEvidenceSink(config?: EvidenceSinkConfig): EvidenceSink {
  if (!config) {
    return new MemoryEvidenceSink();
  }

  switch (config.type) {
    case "memory":
      return new MemoryEvidenceSink();
    case "file":
      return new FileEvidenceSink(config.path);
    case "custom":
      return config.sink;
    default:
      return new MemoryEvidenceSink();
  }
}
