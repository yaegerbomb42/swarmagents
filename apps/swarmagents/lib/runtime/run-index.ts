/**
 * Durable run summary index.
 *
 * Listing runs used to re-read and JSON-parse every run's event segments just
 * to derive status/cost/owner, making `GET /api/runtime/runs` O(total bytes of
 * run logs) and blocking the event loop. The index keeps one small summary
 * sidecar per run (`<runId>.summary.json`) next to the logs:
 *
 *   - the write path (`TelemetryBus.publish`, orphan recovery) updates the
 *     cached summary incrementally for each appended event and rewrites the
 *     sidecar atomically;
 *   - the read path (listRuns) reads only the sidecar. If a run has no sidecar
 *     yet (logs written before this index existed, or a failed write), the
 *     sidecar is corrupt, or the log has been appended to since the sidecar
 *     was written (a crash between append and index update), the summary is
 *     rebuilt from the log once and the sidecar is written back, so existing
 *     installs migrate lazily and stale entries self-heal.
 *
 * A process-local cache keyed by the sidecar's mtime/size and the run log's
 * mtime/size avoids re-parsing unchanged files. Nothing here throws: telemetry
 * persistence and listing must never be broken by an index problem.
 */

import fs from "node:fs";
import path from "node:path";
import type { SequencedEvent } from "../telemetry/bus";
import { RUN_ID_RE } from "../telemetry/paths";
import { readRunEvents, runLogFile } from "../telemetry/run-log";
import { applyEventToSummary, summarizeRun, type StoredRunSummary } from "./run-summary";

/** Version of the on-disk summary sidecar; bump on incompatible changes. */
export const RUN_INDEX_VERSION = 1;

/** Bound the process-local cache so a long-lived server cannot grow forever. */
const MAX_CACHE_ENTRIES = 4096;

interface RunIndexFile {
  version: number;
  runId: string;
  /**
   * Stat of the run's active JSONL segment when this summary was written.
   * The read path compares it with the current stat so a sidecar left behind
   * by a crash (log appended, index write lost) or an out-of-band append is
   * detected and rebuilt instead of serving stale status forever.
   */
  logMtimeMs: number;
  logSize: number;
  summary: StoredRunSummary;
}

/** Identity of one version of the active run log. */
interface LogStamp {
  mtimeMs: number;
  size: number;
}

interface CacheEntry {
  summary: StoredRunSummary;
  sidecar: LogStamp;
  log: LogStamp;
}

type RunEventReader = (runId: string, runsDir: string) => SequencedEvent[];

let eventReader: RunEventReader = readRunEvents;
let eventReadCount = 0;
const cache = new Map<string, CacheEntry>();

/** Path of a run's summary sidecar. */
export function runIndexFile(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.summary.json`);
}

function cacheKey(runsDir: string, runId: string): string {
  return `${runsDir}\0${runId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredRunSummary(value: unknown, runId: string): value is StoredRunSummary {
  if (!isRecord(value)) return false;
  const status = value.status;
  return (
    value.runId === runId &&
    typeof value.createdAt === "number" &&
    typeof value.lastSeq === "number" &&
    typeof value.prompt === "string" &&
    (value.kind === "agent" || value.kind === "shell") &&
    typeof value.tokensIn === "number" &&
    typeof value.tokensOut === "number" &&
    typeof value.tokensCached === "number" &&
    typeof value.tokensReported === "boolean" &&
    (status === "queued" ||
      status === "running" ||
      status === "paused" ||
      status === "finished" ||
      status === "error" ||
      status === "cancelled")
  );
}

/** Stat of the active log segment; a missing log reads as the zero stamp. */
function activeLogStamp(runsDir: string, runId: string): LogStamp {
  try {
    const stat = fs.statSync(runLogFile(runsDir, runId));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function remember(
  key: string,
  summary: StoredRunSummary,
  sidecarStat: { mtimeMs: number; size: number },
  logStamp: LogStamp,
): void {
  cache.set(key, {
    summary,
    sidecar: { mtimeMs: sidecarStat.mtimeMs, size: sidecarStat.size },
    log: logStamp,
  });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function sameStamp(a: LogStamp, b: LogStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

interface ParsedIndex {
  summary: StoredRunSummary;
  logStamp: LogStamp;
}

/** Read and validate the sidecar, or null when it is missing or corrupt. */
function readIndexFile(file: string, runId: string): ParsedIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== RUN_INDEX_VERSION) return null;
    const summary = parsed.summary;
    if (!isStoredRunSummary(summary, runId)) return null;
    const mtimeMs = parsed.logMtimeMs;
    const size = parsed.logSize;
    if (typeof mtimeMs !== "number" || typeof size !== "number") return null;
    return { summary, logStamp: { mtimeMs, size } };
  } catch {
    return null;
  }
}

/** Write a sidecar atomically (temp file + rename). Never throws. */
function writeIndexFile(runsDir: string, summary: StoredRunSummary): LogStamp | null {
  const file = runIndexFile(runsDir, summary.runId);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const logStamp = activeLogStamp(runsDir, summary.runId);
  try {
    const body: RunIndexFile = {
      version: RUN_INDEX_VERSION,
      runId: summary.runId,
      logMtimeMs: logStamp.mtimeMs,
      logSize: logStamp.size,
      summary,
    };
    fs.writeFileSync(tmp, JSON.stringify(body), "utf8");
    fs.renameSync(tmp, file);
    return logStamp;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file may not exist; nothing else to do.
    }
    console.error(`[run-index] could not write summary for ${summary.runId}:`, err);
    return null;
  }
}

/** Rebuild a summary from the run's persisted events (the migration path). */
function rebuildSummary(runId: string, runsDir: string): StoredRunSummary | null {
  eventReadCount += 1;
  const events = eventReader(runId, runsDir);
  if (events.length === 0) return null;
  return summarizeRun(runId, events);
}

interface LoadedSummary {
  summary: StoredRunSummary;
  /** True when the sidecar was missing/corrupt and just rebuilt from the log. */
  rebuilt: boolean;
}

/**
 * Resolve the summary object for a run, preferring the cache. When the sidecar
 * is missing, corrupt, or older than the log (a crash between append and index
 * write, or an out-of-band append) the summary is rebuilt from the log and
 * written back.
 *
 * `requireFreshLog` is false only on the append path: the caller just appended
 * the event in hand, so the log is expected to be *ahead* of the sidecar and
 * comparing stamps would force a full rebuild on every event. The sequence
 * check in `updateRunIndex` still catches a sidecar that is behind by more than
 * the one event being applied.
 *
 * Returns the cached instance (callers may fold an event into it); public
 * readers get a copy from `readRunSummary`.
 */
function loadSummary(runId: string, runsDir: string, requireFreshLog: boolean): LoadedSummary | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const file = runIndexFile(runsDir, runId);
  const key = cacheKey(runsDir, runId);

  let sidecarStat: fs.Stats | null = null;
  try {
    sidecarStat = fs.statSync(file);
  } catch {
    sidecarStat = null;
  }
  const currentLog = activeLogStamp(runsDir, runId);

  if (sidecarStat) {
    const cached = cache.get(key);
    if (
      cached &&
      sameStamp(cached.sidecar, sidecarStat) &&
      (!requireFreshLog || sameStamp(cached.log, currentLog))
    ) {
      return { summary: cached.summary, rebuilt: false };
    }
    const parsed = readIndexFile(file, runId);
    if (parsed && (!requireFreshLog || sameStamp(parsed.logStamp, currentLog))) {
      remember(key, parsed.summary, sidecarStat, parsed.logStamp);
      return { summary: parsed.summary, rebuilt: false };
    }
  }

  // Missing, corrupt, or stale: rebuild from the log once, then persist.
  const rebuilt = rebuildSummary(runId, runsDir);
  if (!rebuilt) {
    cache.delete(key);
    return null;
  }
  const writtenStamp = writeIndexFile(runsDir, rebuilt);
  if (writtenStamp) {
    try {
      const fresh = fs.statSync(file);
      remember(key, rebuilt, fresh, writtenStamp);
    } catch {
      cache.delete(key);
    }
  }
  return { summary: rebuilt, rebuilt: true };
}

/**
 * Read a run's summary from the index without touching its event segments in
 * the common case. Returns a copy so callers can attach transient fields
 * (e.g. report meta) without mutating the cache.
 */
export function readRunSummary(
  runId: string,
  runsDir: string,
): StoredRunSummary | null {
  const loaded = loadSummary(runId, runsDir, true);
  return loaded ? { ...loaded.summary } : null;
}

/**
 * Fold a freshly appended event into the run's cached summary and rewrite the
 * sidecar. Fast path is O(1); when the sidecar is missing or the sequence has
 * a gap (crash, manual edit) it falls back to rebuilding from the log, which
 * already contains the event being recorded here.
 */
export function updateRunIndex(event: SequencedEvent, runsDir: string): void {
  const runId = event.runId;
  if (!RUN_ID_RE.test(runId)) return;

  const loaded = loadSummary(runId, runsDir, false);
  // A just-rebuilt summary already folded this event in (the append happened
  // before this call), so there is nothing more to apply.
  if (loaded?.rebuilt) return;

  let summary: StoredRunSummary | null;
  if (loaded && event.seq === loaded.summary.lastSeq + 1) {
    applyEventToSummary(loaded.summary, event);
    summary = loaded.summary;
  } else {
    summary = rebuildSummary(runId, runsDir);
  }
  if (!summary) return;

  const key = cacheKey(runsDir, runId);
  const writtenStamp = writeIndexFile(runsDir, summary);
  if (writtenStamp) {
    try {
      const fresh = fs.statSync(runIndexFile(runsDir, runId));
      remember(key, summary, fresh, writtenStamp);
    } catch {
      cache.delete(key);
    }
  }
}

/** Drop all process-local cache entries (tests, or after an out-of-band edit). */
export function clearRunIndexCache(): void {
  cache.clear();
}

/**
 * Replace the event reader used for index rebuilds. Tests use this to spy on
 * (or forbid) full-log reads during listing; pass null to restore the default.
 */
export function setRunIndexEventReaderForTests(reader: RunEventReader | null): void {
  eventReader = reader ?? readRunEvents;
  eventReadCount = 0;
}

/** Number of full-log rebuilds performed since the reader was last reset. */
export function runIndexEventReadCount(): number {
  return eventReadCount;
}
