/**
 * Durable trace-signal sender — let real, ongoing `@strixgov/governed-action`
 * usage feed Live Trace-Driven Revocation's Phase 1 (ADVISORY) recording,
 * not just one-off ceremony scripts.
 *
 * Wire contract: `apps/strix-console/src/lib/integrations/trace-signal-advisory.ts`'s
 * `context.traceSignals` slot — `{ schema: 'strix.trace-signals.v1', events: [...],
 * declaredPairs? }`. That module's own docstring is explicit about the division
 * of labor: "the caller owns its own run history in Phase 1 (there is no
 * server-side stream yet — that is a Phase-2 Gate-D decision)." This module IS
 * that ownership on the SDK side: it accumulates a bounded, durable window of
 * one run's governed-action calls and re-sends the whole window on every
 * `evaluate()` call, so the server's Phase-1 detectors (repetition / budget
 * trajectory / sequence divergence) see real, multi-call context instead of
 * one isolated action at a time.
 *
 * OFF BY DEFAULT (opt-in). Sending this is inert whenever the operator's
 * server-side `STRIX_TRACE_SIGNALS_V1` flag is off (the server reports
 * `status: 'DISABLED'` and ignores it) — but persisting history to disk IS a
 * new side effect this package did not have before, and a package this
 * security-conscious should not introduce a new filesystem footprint
 * silently. Turn it on globally with `STRIX_TRACE_SIGNALS_SDK=true`, or
 * per-call via `governedAction({ ..., trace: true }, op)`.
 *
 * DURABLE: history for a run persists to disk (default
 * `.strix/trace/<tenant>/<run>.json` under the current working directory,
 * overridable via `STRIX_TRACE_DIR` or the `traceDir` option) so a CI job or
 * long-running agent that restarts BETWEEN calls — the exact case a
 * ceremony script cannot cover — keeps contributing to the SAME run's
 * history instead of resetting it every process. `traceDir: false` (or
 * `STRIX_TRACE_DIR=false`) disables persistence for an in-memory-only,
 * per-process fallback.
 *
 * PARTITIONED BY TENANT, NOT ONLY BY RUN. History is keyed by the PAIR
 * (tenantId, runId) in memory and on disk, and every stored event carries
 * the tenantId that produced it. An earlier cut keyed on runId alone and
 * stamped `tenantId` onto each event at SEND time from the CURRENT call, so
 * two tenants sharing a runId did not merely see each other's events —
 * each request RELABELED the other tenant's events as its own. That is both
 * a leak (a foreign tenant's capabilityIds and payloadHashes ride this
 * tenant's request body and land on its decision row) and a fabrication
 * (the events assert a tenantId that did not take them). The zero-config
 * path was the exposed one: with no runId declared, every call in a process
 * shares one generated `processRunId`, which is exactly the shape of a
 * multi-tenant service. `tenantId` is now READ BACK from the stored event
 * and required to match, so the isolation is verified at the point of use
 * rather than inferred from where the file happened to sit. `runId` is
 * deliberately NOT given the same treatment: a mislabeled run is a
 * telemetry-quality problem, a mislabeled tenant is a boundary violation.
 *
 * NOT A TRANSACTIONAL STORE: persistence is best-effort. Two concurrent
 * callers racing on the SAME runId can each read the prior history before
 * either writes, so one's increment can be lost from disk (last write
 * wins) — an accepted tradeoff, since this data never gates a verdict.
 * Writes still go through a temp-file-then-atomic-rename so a race can only
 * ever lose an update, never corrupt the file into invalid JSON.
 *
 * NEVER THROWS, NEVER BLOCKS THE GOVERNED ACTION. Every failure mode here —
 * disk unavailable, corrupt history file, a read-only filesystem — degrades
 * to "send no trace-signal data for this call," exactly as if the feature
 * were off. This mirrors `trace-signal-advisory.ts`'s own fail-OPEN posture
 * for this exact slot on the server side; the two halves of one advisory
 * feature should fail the same direction.
 *
 * BOUNDED: `maxEvents` (default 50) caps both what is persisted and what is
 * sent, keeping the oldest events out rather than growing without limit —
 * matching the server detectors' own bounded-window design (repetition's
 * `windowSize`, budget-trajectory's `horizonEvents`) rather than trying to
 * be a complete run history.
 */

import { sha256Hex } from './sha256.js';

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_TRACE_DIR = '.strix/trace';

export interface TraceHistoryEvent {
  /**
   * The tenant that produced this event. Stored, not derived at send time —
   * see the PARTITIONED BY TENANT note in the module header. A loaded event
   * whose tenantId does not match the caller's is never sent.
   */
  tenantId: string;
  seq: number;
  capabilityId: string;
  payloadHash: string;
  declaredBudgets?: Record<string, number>;
  consumption?: Record<string, number>;
  occurredAt: string;
}

/** Per-call trace options. `true` uses every default. */
export type TraceOption =
  | boolean
  | {
      runId?: string;
      traceDir?: string | false;
      maxEvents?: number;
      declaredPairs?: Array<[string, string]>;
      declaredBudgets?: Record<string, number>;
      consumption?: Record<string, number>;
    };

export interface TraceSignalsWireSlot {
  schema: 'strix.trace-signals.v1';
  events: Array<{
    runId: string;
    tenantId: string;
    seq: number;
    capabilityId: string;
    payloadHash: string;
    declaredBudgets?: Record<string, number>;
    consumption?: Record<string, number>;
    occurredAt: string;
  }>;
  declaredPairs?: Array<[string, string]>;
}

function env(): Record<string, string | undefined> {
  return (typeof process !== 'undefined' && process.env) || {};
}

/**
 * `true` when the caller passed an explicit `trace` option, OR the caller
 * passed nothing (`undefined`) but the global opt-in env var is set.
 * `trace: false` always wins — an explicit per-call opt-out is never
 * overridden by the global flag.
 */
export function isTraceOptionEnabled(option: TraceOption | undefined): boolean {
  if (option === false) return false;
  if (option === true || (option !== undefined && typeof option === 'object')) return true;
  return env().STRIX_TRACE_SIGNALS_SDK === 'true';
}

// One stable id per process for the common zero-configuration case: repeated
// governedAction calls in the SAME process still accumulate a real,
// multi-event trace even with no runId/env var declared. Cross-process
// continuity is an explicit choice (STRIX_RUN_ID or the `runId` option),
// never guessed.
let processRunId: string | null = null;

function randomId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * The one definition of a tenant id's on-the-wire form. `governedAction()`
 * calls this before it sends, and `traceHistoryFilePath()` calls it before it
 * derives a path, so the two cannot drift into disagreeing about which file a
 * given caller's history lives in.
 */
export function normalizeTenantId(raw: string | undefined | null): string {
  return (raw ?? '').trim();
}

export function resolveRunId(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const fromEnv = env().STRIX_RUN_ID;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (!processRunId) processRunId = randomId();
  return processRunId;
}

function resolveTraceDir(explicit?: string | false): string | null {
  if (explicit === false) return null;
  if (explicit) return explicit;
  const fromEnv = env().STRIX_TRACE_DIR;
  if (fromEnv === 'false' || fromEnv === '0') return null;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return DEFAULT_TRACE_DIR;
}

/**
 * One filesystem-safe path segment for an identifier — never letting a
 * caller-supplied or env-supplied value escape the trace directory, and
 * never letting two DISTINCT identifiers land on one file.
 *
 * The second half is the part worth stating: a plain
 * replace-unsafe-with-underscore rule is not injective, so `run/a` and
 * `run_a` — or two tenant ids differing only in punctuation — would share a
 * history file and silently merge. That is the same contamination the
 * tenant partition exists to prevent, arriving through the filename
 * instead. The sha256 suffix is over the RAW value, so distinct inputs
 * cannot collide; the readable prefix is for a human reading `ls`, and is
 * truncated (the digest, not the prefix, carries the identity).
 */
async function safeSegment(raw: string): Promise<string> {
  const readable = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'id';
  return `${readable}-${(await sha256Hex(raw)).slice(0, 32)}`;
}

/**
 * In-memory key for one (tenant, run) pair. `JSON.stringify` of the tuple is
 * injective — unlike a delimiter-joined string, no value a caller supplies
 * can make two distinct pairs collide.
 */
function historyKey(tenantId: string, runId: string): string {
  return JSON.stringify([tenantId, runId]);
}

/** A stored event is usable only if it names the tenant asking for it. */
function belongsToTenant(value: unknown, tenantId: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { tenantId?: unknown }).tenantId === tenantId
  );
}

// In-memory fallback, keyed by (tenantId, runId), for when disk is disabled
// or unavailable — keeps THIS process's own calls contributing to the trace
// even with zero filesystem access (e.g. a sandboxed runtime).
const memoryHistories = new Map<string, TraceHistoryEvent[]>();

async function historyPath(
  traceDir: string,
  tenantId: string,
  runId: string,
): Promise<{ dir: string; file: string }> {
  const { join } = await import('node:path');
  const dir = join(traceDir, await safeSegment(tenantId));
  return { dir, file: join(dir, `${await safeSegment(runId)}.json`) };
}

async function loadHistory(
  tenantId: string,
  runId: string,
  traceDir: string | null,
): Promise<TraceHistoryEvent[]> {
  if (traceDir) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { file } = await historyPath(traceDir, tenantId, runId);
      const text = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      // Every event must name THIS tenant. A file that does not is treated
      // exactly like a corrupt one — dropped, never partially adopted. A
      // pre-partition file written by an older version has no tenantId at
      // all and cannot prove whose events it holds, so it is dropped for the
      // same reason rather than inherited; losing one run's advisory history
      // is the safe direction.
      if (Array.isArray(parsed) && parsed.every((e) => belongsToTenant(e, tenantId))) {
        return parsed as TraceHistoryEvent[];
      }
    } catch {
      /* missing, unreadable, or corrupt — fall through to the in-memory copy */
    }
  }
  return memoryHistories.get(historyKey(tenantId, runId)) ?? [];
}

/**
 * Best-effort durability, NOT a transactional store: two concurrent callers
 * racing on the SAME runId can each read the same prior history before
 * either writes, so one's update can be lost from disk (last write wins).
 * That is an accepted tradeoff for advisory, non-enforcement telemetry —
 * this data never gates a verdict — but writing via a temp file + atomic
 * rename still matters: it turns "concurrent writers might corrupt the file
 * into invalid JSON" (a real risk with a direct `writeFile` to the same
 * path) into "concurrent writers race on which complete, valid write wins"
 * (a lost update, never corruption). `loadHistory`'s own try/catch treats a
 * corrupt file as empty, so a torn write would silently reset the run's
 * history rather than merely lose one increment — worth closing even
 * without full lock-based lost-update prevention.
 */
async function saveHistory(
  tenantId: string,
  runId: string,
  traceDir: string | null,
  events: TraceHistoryEvent[],
): Promise<void> {
  memoryHistories.set(historyKey(tenantId, runId), events);
  if (!traceDir) return;
  try {
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { dir, file } = await historyPath(traceDir, tenantId, runId);
    await mkdir(dir, { recursive: true });
    // Unique per-write suffix so two concurrent writers use DIFFERENT temp
    // files — without this, they could race on the same temp path and one's
    // rename would clobber mid-write, which is exactly the corruption this
    // pattern exists to avoid. The temp file sits in the SAME tenant
    // directory as its target so the rename stays within one filesystem.
    const tmpPath = join(dir, `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(tmpPath, JSON.stringify(events), 'utf8');
    await rename(tmpPath, file); // atomic on the same filesystem (POSIX + Windows NTFS)
  } catch {
    /* best-effort durability only — the in-memory copy above still holds for this process */
  }
}

/**
 * Where one (tenant, run) history file lives — the SAME resolution the
 * writer uses, exported so a caller (or a test) can locate, inspect, or
 * delete it without re-deriving the naming rule. A second implementation of
 * that rule could drift from this one and quietly point at the wrong file,
 * which is the whole failure class `safeSegment` exists to close.
 *
 * Returns `null` when persistence is disabled for these options — there is
 * no file, and saying so is more honest than returning a path that will
 * never exist.
 */
export async function traceHistoryFilePath(input: {
  tenantId: string;
  runId?: string;
  traceDir?: string | false;
}): Promise<string | null> {
  const traceDir = resolveTraceDir(input.traceDir);
  if (!traceDir) return null;
  // Normalize through the SAME functions the writer uses, never a second copy
  // of the rule. `governedAction()` trims the tenant id and resolves the run
  // id through `resolveRunId` (which trims, then falls back to STRIX_RUN_ID
  // and finally this process's own id). Hashing the caller's raw string
  // instead would hand back a path for a whitespace-padded identifier that
  // nothing ever writes to — and a helper whose entire job is to locate or
  // delete a run's history is worse than useless if it can point at a file
  // that does not exist. An unusable tenant id gets the same honest `null` as
  // disabled persistence: there is no file.
  const tenantId = normalizeTenantId(input.tenantId);
  if (!tenantId) return null;
  const { file } = await historyPath(traceDir, tenantId, resolveRunId(input.runId));
  return file;
}

export interface RecordAttemptInput {
  tenantId: string;
  capabilityId: string;
  payloadHash: string;
  option: TraceOption | undefined;
}

/**
 * Record this call's attempt into the run's durable history and return the
 * wire-shaped slot for `context.traceSignals` — or `null` if trace-signal
 * participation is off, or if anything about tracking it failed. A `null`
 * return means "send no traceSignals field this call," never a thrown
 * error: nothing in this module may ever prevent or delay the governed
 * action it is merely riding alongside.
 */
export async function recordAttemptAndBuildSlot(
  input: RecordAttemptInput,
): Promise<TraceSignalsWireSlot | null> {
  if (!isTraceOptionEnabled(input.option)) return null;
  const opts = typeof input.option === 'object' ? input.option : {};

  try {
    const runId = resolveRunId(opts.runId);
    const traceDir = resolveTraceDir(opts.traceDir);
    const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;

    const existing = await loadHistory(input.tenantId, runId, traceDir);
    const nextSeq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 0;

    const entry: TraceHistoryEvent = {
      tenantId: input.tenantId,
      seq: nextSeq,
      capabilityId: input.capabilityId,
      payloadHash: input.payloadHash,
      occurredAt: new Date().toISOString(),
      // Conditionally spread, never assigned as an explicit `undefined` key —
      // the request body this eventually enters is canonicalized via SCJ v1
      // (canonicalizeJSONScjV1Mirror in index.ts), which throws on any
      // explicit `undefined`-valued field. Same discipline as this session's
      // trace-signals streaming-plane fix in transport.ts's toTraceEvent.
      ...(opts.declaredBudgets !== undefined ? { declaredBudgets: opts.declaredBudgets } : {}),
      ...(opts.consumption !== undefined ? { consumption: opts.consumption } : {}),
    };

    const updated = [...existing, entry].slice(-maxEvents);
    await saveHistory(input.tenantId, runId, traceDir, updated);

    const slot: TraceSignalsWireSlot = {
      schema: 'strix.trace-signals.v1',
      // `tenantId` comes from the EVENT, never re-stamped from this call —
      // loadHistory has already refused anything that does not name this
      // tenant, so the wire value is read back rather than asserted.
      events: updated.map((e) => ({ runId, ...e })),
    };
    if (opts.declaredPairs && opts.declaredPairs.length > 0) {
      slot.declaredPairs = opts.declaredPairs;
    }
    return slot;
  } catch {
    return null;
  }
}
