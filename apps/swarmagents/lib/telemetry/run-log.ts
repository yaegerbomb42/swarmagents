import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { SequencedEvent } from "./bus";
import { RUN_ID_RE } from "./paths";

export const MAX_RUN_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_RUN_EVENT_BYTES = 256 * 1024;
export const MAX_RUN_RETAINED_BYTES = 20 * 1024 * 1024;
export const MAX_RUN_LOG_TOTAL_BYTES = 200 * 1024 * 1024;

const LOG_NAME_RE = /^([A-Za-z0-9_-]{1,64})\.jsonl(?:\.(\d+))?$/;

/** Yield to the event loop this often while streaming a segment. */
const REPLAY_YIELD_EVERY = 512;
/** New-viewer replay is capped to the most recent events for responsiveness. */
export const INITIAL_REPLAY_CAP = 2000;
/** Bytes read from the head of a segment to probe its first seq. */
const PROBE_HEAD_BYTES = 4096;
/** Segment-index cache entries kept before the oldest run is evicted. */
const SEGMENT_INDEX_CACHE_MAX = 512;

const runsDirReady = new Set<string>();
const nextRotationByBase = new Map<string, number>();
const writeQueues = new Map<string, Promise<void>>();
const pendingByRun = new Map<string, SequencedEvent[]>();

export function runLogFile(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.jsonl`);
}

function ensureRunsDir(runsDir: string): void {
  if (runsDirReady.has(runsDir)) return;
  fs.mkdirSync(runsDir, { recursive: true });
  runsDirReady.add(runsDir);
}

function rotationFile(base: string): string {
  let n = nextRotationByBase.get(base) ?? 1;
  while (fs.existsSync(`${base}.${n}`)) n += 1;
  nextRotationByBase.set(base, n + 1);
  return `${base}.${n}`;
}

function rememberRotationFromName(base: string, name: string): void {
  const m = LOG_NAME_RE.exec(path.basename(name));
  if (!m || !m[2]) return;
  const n = Number(m[2]);
  const cur = nextRotationByBase.get(base) ?? 1;
  if (n >= cur) nextRotationByBase.set(base, n + 1);
}

/**
 * Files whose size is known to sit exactly on a line boundary, keyed by
 * absolute path. Checked before appending so the common case does not need to
 * read the last byte; a stale entry is harmless because the cached size must
 * match the file's current size before it is trusted.
 */
const framedSizes = new Map<string, number>();
const FRAMED_CACHE_MAX = 512;

function rememberFramed(file: string, size: number): void {
  framedSizes.delete(file);
  framedSizes.set(file, size);
  if (framedSizes.size > FRAMED_CACHE_MAX) {
    const oldest = framedSizes.keys().next().value;
    if (oldest !== undefined) framedSizes.delete(oldest);
  }
}

function lastByteIsNewline(file: string, size: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1);
    return fs.readSync(fd, buf, 0, 1, size - 1) === 1 && buf[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Return the file size after guaranteeing the file ends on "\n". A torn tail
 * (crash mid-append, SIGKILL, force-exit, ENOSPC) leaves a partial JSON line
 * with no terminator; without repair the next append would concatenate onto
 * it, making a single unparseable line and silently losing both events. We
 * terminate the partial line instead, so replay skips only the torn line and
 * the new event stays readable.
 */
function ensureLineBoundary(file: string, size: number): number {
  if (size === 0) return 0;
  if (framedSizes.get(file) === size) return size;
  if (lastByteIsNewline(file, size)) {
    rememberFramed(file, size);
    return size;
  }
  fs.appendFileSync(file, "\n", "utf8");
  const repaired = size + 1;
  rememberFramed(file, repaired);
  return repaired;
}

function truncateForLog(event: SequencedEvent, maxBytes: number): SequencedEvent {
  let line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return event;
  const base: Record<string, unknown> = {
    ...((event as unknown) as Record<string, unknown>),
    truncated: true,
  };
  // Prefer trimming large payload fields, then fall back to a compact marker.
  for (const key of ["data", "text", "message", "output", "error", "args", "result"]) {
    if (typeof base[key] === "string") {
      const s = base[key] as string;
      base[key] = s.length > 512 ? `${s.slice(0, 512)}…[truncated]` : s;
    } else if (base[key] !== undefined) {
      try {
        const s = JSON.stringify(base[key]);
        base[key] = s.length > 512 ? `${s.slice(0, 512)}…[truncated]` : base[key];
      } catch {
        base[key] = "[unserializable]";
      }
    }
    line = `${JSON.stringify(base)}\n`;
    if (Buffer.byteLength(line, "utf8") <= maxBytes) return base as unknown as SequencedEvent;
  }
  const minimal: Record<string, unknown> = {
    runId: event.runId,
    seq: event.seq,
    ts: event.ts,
    type: (event as unknown as { type?: unknown }).type ?? "log",
    truncated: true,
    data: "[event truncated]",
  };
  line = `${JSON.stringify(minimal)}\n`;
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return minimal as unknown as SequencedEvent;
  minimal.data = "[truncated]";
  return minimal as unknown as SequencedEvent;
}

function listRunSegmentFiles(runId: string, runsDir: string): string[] {
  try {
    const names = fs.readdirSync(runsDir);
    const base = runLogFile(runsDir, runId);
    const rotated: Array<{ n: number; file: string }> = [];
    for (const name of names) {
      const m = LOG_NAME_RE.exec(name);
      if (!m || m[1] !== runId || !m[2]) continue;
      const file = path.join(runsDir, name);
      rotated.push({ n: Number(m[2]), file });
      rememberRotationFromName(base, file);
    }
    rotated.sort((a, b) => a.n - b.n);
    return [...rotated.map((r) => r.file), base];
  } catch {
    return [];
  }
}

function totalRunLogBytes(runId: string, runsDir: string): number {
  let total = 0;
  for (const file of listRunSegmentFiles(runId, runsDir)) {
    try { total += fs.statSync(file).size; } catch { /* missing */ }
  }
  return total;
}

function totalRunsDirBytes(runsDir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(runsDir)) {
      if (!LOG_NAME_RE.test(name)) continue;
      try { total += fs.statSync(path.join(runsDir, name)).size; } catch { /* missing */ }
    }
  } catch { /* no dir */ }
  return total;
}

function enforceRetention(runId: string, runsDir: string, perRunMaxBytes: number, globalMaxBytes: number): void {
  // Per-run: delete oldest rotated segments first.
  const base = runLogFile(runsDir, runId);
  let runTotal = totalRunLogBytes(runId, runsDir);
  if (runTotal > perRunMaxBytes) {
    const segments = listRunSegmentFiles(runId, runsDir).filter((f) => f !== base);
    for (const seg of segments) {
      if (runTotal <= perRunMaxBytes) break;
      try {
        const sz = fs.statSync(seg).size;
        fs.rmSync(seg, { force: true });
        framedSizes.delete(seg);
        runTotal -= sz;
      } catch { /* ignore */ }
    }
  }

  // Global: delete oldest rotated segments across all runs.
  let globalTotal = totalRunsDirBytes(runsDir);
  if (globalTotal > globalMaxBytes) {
    let candidates: Array<{ file: string; mtimeMs: number; size: number; isBase: boolean }> = [];
    try {
      for (const name of fs.readdirSync(runsDir)) {
        const m = LOG_NAME_RE.exec(name);
        if (!m) continue;
        const file = path.join(runsDir, name);
        try {
          const st = fs.statSync(file);
          candidates.push({ file, mtimeMs: st.mtimeMs, size: st.size, isBase: !m[2] });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    // Prefer deleting rotated segments; keep active base files as last resort.
    candidates.sort((a, b) => (Number(a.isBase) - Number(b.isBase)) || (a.mtimeMs - b.mtimeMs));
    for (const c of candidates) {
      if (globalTotal <= globalMaxBytes) break;
      try {
        fs.rmSync(c.file, { force: true });
        framedSizes.delete(c.file);
        globalTotal -= c.size;
      } catch { /* ignore */ }
    }
  }
}

function writeEventSync(
  event: SequencedEvent,
  runsDir: string,
  maxBytes: number,
  perRunMaxBytes: number,
  globalMaxBytes: number,
): void {
  if (!RUN_ID_RE.test(event.runId)) return;
  const bounded = truncateForLog(event, MAX_RUN_EVENT_BYTES);
  const line = `${JSON.stringify(bounded)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  const file = runLogFile(runsDir, event.runId);
  try {
    ensureRunsDir(runsDir);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* No active file yet. */ }
    size = ensureLineBoundary(file, size);
    if (size > 0 && size + bytes > maxBytes) {
      const rotated = rotationFile(file);
      fs.renameSync(file, rotated);
      rememberFramed(rotated, size);
      framedSizes.delete(file);
      size = 0;
      enforceRetention(event.runId, runsDir, perRunMaxBytes, globalMaxBytes);
    }
    // If per-run/global limits are already exceeded, still try to write the new event
    // (it may be the latest important signal) but enforce retention again.
    fs.appendFileSync(file, line, "utf8");
    rememberFramed(file, size + bytes);
    const runTotal = totalRunLogBytes(event.runId, runsDir);
    const globalTotal = totalRunsDirBytes(runsDir);
    if (runTotal > perRunMaxBytes || globalTotal > globalMaxBytes) {
      enforceRetention(event.runId, runsDir, perRunMaxBytes, globalMaxBytes);
    }
  } catch (err) {
    // Telemetry persistence must never break a live run.
    console.error(`[telemetry] could not persist event for ${event.runId}:`, err);
  }
}

function drainPendingSync(runId: string): void {
  const pending = pendingByRun.get(runId);
  if (!pending || pending.length === 0) return;
  // Pending writes are flushed by the queue; this is a safety net for sync readers.
  // We can't force-await here, but we can write synchronously if anything remains.
  while (pending.length > 0) {
    const item = pending.shift()!;
    const meta = (item as unknown as { __logMeta?: { runsDir: string; maxBytes: number; perRunMaxBytes: number; globalMaxBytes: number } }).__logMeta;
    if (meta) writeEventSync(item, meta.runsDir, meta.maxBytes, meta.perRunMaxBytes, meta.globalMaxBytes);
  }
  pendingByRun.delete(runId);
}

/**
 * Append one event as a JSON line. Writes are serialized per run through an
 * async queue and drained by flushRunLogs() on shutdown. For sync reader
 * compatibility, the write is performed immediately and the queue tracks
 * completion.
 */
export function appendRunEvent(
  event: SequencedEvent,
  runsDir: string,
  maxBytes: number = MAX_RUN_LOG_BYTES,
  perRunMaxBytes: number = MAX_RUN_RETAINED_BYTES,
  globalMaxBytes: number = MAX_RUN_LOG_TOTAL_BYTES,
): void {
  if (!RUN_ID_RE.test(event.runId)) return;
  // Attach meta for safety-net drains (non-enumerable to avoid polluting JSON).
  try {
    Object.defineProperty(event as unknown as Record<string, unknown>, "__logMeta", {
      value: { runsDir, maxBytes, perRunMaxBytes, globalMaxBytes },
      enumerable: false,
      configurable: true,
    });
  } catch { /* ignore */ }

  const runId = event.runId;
  const prev = writeQueues.get(runId) ?? Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const next = prev.catch(() => {}).then(() => {
    try {
      const pending = pendingByRun.get(runId);
      if (pending) {
        const idx = pending.indexOf(event);
        if (idx >= 0) pending.splice(idx, 1);
        if (pending.length === 0) pendingByRun.delete(runId);
      }
      // If already written by a sync drain, skip.
      const marker = (event as unknown as { __written?: boolean }).__written;
      if (!marker) {
        writeEventSync(event, runsDir, maxBytes, perRunMaxBytes, globalMaxBytes);
        try { (event as unknown as Record<string, unknown>).__written = true; } catch { /* */ }
      }
    } finally {
      resolveDone();
    }
  });
  writeQueues.set(runId, next);

  const pending = pendingByRun.get(runId) ?? [];
  pending.push(event);
  pendingByRun.set(runId, pending);

  // Perform the write now for sync-reader compatibility, but keep the queue
  // as the serialization/drain point.
  try {
    const pendingNow = pendingByRun.get(runId);
    if (pendingNow) {
      const idx = pendingNow.indexOf(event);
      if (idx >= 0) pendingNow.splice(idx, 1);
      if (pendingNow.length === 0) pendingByRun.delete(runId);
    }
    writeEventSync(event, runsDir, maxBytes, perRunMaxBytes, globalMaxBytes);
    try { (event as unknown as Record<string, unknown>).__written = true; } catch { /* */ }
  } catch { /* writeEventSync already logs */ }
}

export interface RunLogInfo {
  runId: string;
  file: string;
  mtimeMs: number;
}

async function drainPendingAsync(runId: string): Promise<void> {
  const q = writeQueues.get(runId);
  if (q) {
    try { await q; } catch { /* best effort */ }
  }
  drainPendingSync(runId);
}

/**
 * Drain pending per-run writes and fsync every run-log segment on disk so
 * in-flight telemetry reaches durable storage before the process exits.
 * Best-effort: missing or rotated files are skipped, never thrown.
 */
export async function flushRunLogs(runsDir: string | null): Promise<void> {
  await Promise.all([...writeQueues.values()].map((p) => p.catch(() => {})));
  for (const runId of [...pendingByRun.keys()]) drainPendingSync(runId);
  if (!runsDir) return;
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!LOG_NAME_RE.test(name)) continue;
    const file = path.join(runsDir, name);
    let fd: number | undefined;
    try {
      fd = openForFsync(file);
      fs.fsyncSync(fd);
    } catch {
      // A log file may be rotated or deleted mid-flush; skip it.
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors during shutdown flushing.
        }
      }
    }
  }
}

/**
 * Open a log segment for fsync. "r+" (read/write) is required on some
 * platforms — notably Windows, where fsync on a read-only handle fails —
 * while "r" works everywhere else. Fall back to "r" when the segment cannot
 * be opened for writing (e.g. a frozen read-only rotated segment, or a
 * directory entry), so the flush stays best-effort instead of throwing.
 */
function openForFsync(file: string): number {
  try {
    return fs.openSync(file, "r+");
  } catch {
    return fs.openSync(file, "r");
  }
}

function safeParseEvent(line: string, runId: string): SequencedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { runId?: unknown }).runId === runId &&
      typeof (parsed as { seq?: unknown }).seq === "number"
    ) {
      return parsed as SequencedEvent;
    }
  } catch {
    // Skip a torn trailing line after a crash.
  }
  return null;
}

/** Ordered log files for a run: rotated segments (oldest→newest), then base. */
function listOrderedSegments(runId: string, runsDir: string): string[] {
  const base = runLogFile(runsDir, runId);
  const rotated: Array<{ n: number; file: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  for (const name of names) {
    const match = LOG_NAME_RE.exec(name);
    if (!match || match[1] !== runId || !match[2]) continue;
    rotated.push({ n: Number(match[2]), file: path.join(runsDir, name) });
  }
  rotated.sort((a, b) => a.n - b.n);
  return [...rotated.map((r) => r.file), base];
}

const TAIL_READ_BYTES = 64 * 1024;

/**
 * Last parseable event among the final lines of a file. The tail window
 * starts at TAIL_READ_BYTES and doubles until it holds a parseable event (or
 * covers the whole file), so a single event — or a torn tail — larger than
 * the window cannot hide the events written before it.
 */
function lastEventInTail(fd: number, size: number, runId: string): SequencedEvent | null {
  let readLen = Math.min(size, TAIL_READ_BYTES);
  while (true) {
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    let offset = 0;
    if (readLen < size) {
      const nl = buf.indexOf(0x0a);
      offset = nl === -1 ? 0 : nl + 1;
    }
    const lines = buf.toString("utf8", offset, readLen).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = safeParseEvent(lines[i], runId);
      if (ev) return ev;
    }
    if (readLen === size) return null;
    readLen = Math.min(size, readLen * 2);
  }
}

/** Seq of the first event in a segment, expanding the head probe past a first line larger than PROBE_HEAD_BYTES. */
function probeFirstSeq(fd: number, size: number, runId: string): number {
  let readLen = Math.min(size, PROBE_HEAD_BYTES);
  while (true) {
    const head = Buffer.alloc(readLen);
    fs.readSync(fd, head, 0, readLen, 0);
    const text = head.toString("utf8");
    const nl = text.indexOf("\n");
    if (nl !== -1) {
      return safeParseEvent(text.slice(0, nl), runId)?.seq ?? 0;
    }
    if (readLen === size) {
      // The whole file is one unterminated line; try it as the first event.
      return safeParseEvent(text, runId)?.seq ?? 0;
    }
    readLen = Math.min(size, readLen * 2);
  }
}

/** Last parseable event among the final JSON lines of a log file. */
function lastEventInFileTail(file: string, runId: string): SequencedEvent | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    return lastEventInTail(fd, size, runId);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Best-effort read of the last event ever written for a run. Reads only the
 * newest segment tail (falling back to older segments only when the active
 * file has no parseable line), so it stays cheap on long runs.
 */
export function tailRunLogLastEvent(runId: string, runsDir: string): SequencedEvent | null {
  if (!RUN_ID_RE.test(runId)) return null;
  drainPendingSync(runId);
  const segments = listOrderedSegments(runId, runsDir);
  for (let i = segments.length - 1; i >= 0; i--) {
    const ev = lastEventInFileTail(segments[i], runId);
    if (ev) return ev;
  }
  return null;
}

/** Highest seq ever written for a run (0 when the log is missing/empty). */
export function tailRunLogLastSeq(runId: string, runsDir: string): number {
  return tailRunLogLastEvent(runId, runsDir)?.seq ?? 0;
}

/** Cheap first/last seq probe for a segment (head and tail reads only). */
function probeSegmentRange(file: string, runId: string): { first: number; last: number } {
  const range = { first: 0, last: 0 };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return range;

    range.first = probeFirstSeq(fd, size, runId);
    range.last = lastEventInTail(fd, size, runId)?.seq ?? 0;
    return range;
  } catch {
    return range;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

interface SegmentFile {
  path: string;
  size: number;
}

interface SegmentMeta extends SegmentFile {
  firstSeq: number;
  lastSeq: number;
  /** Number of valid events in the segment, or -1 until it has been counted. */
  count: number;
  /** Events with seq > `fromSeq`, cached per cursor (filled lazily by capped replays). */
  afterCounts: Map<number, number>;
}

/**
 * Small in-memory, per-run index of segment metadata. It lets a reconnect seek
 * straight to the segments that may contain events after its cursor instead of
 * scanning every line of every segment, and lets a new viewer's cap start in
 * the right segment. Entries are reused while a segment's path and size are
 * unchanged; the active segment is re-probed (head/tail reads only) when it
 * grows. Counts are filled lazily, because a reconnect never needs them.
 */
const segmentIndexCache = new Map<string, { files: SegmentFile[]; meta: SegmentMeta[] }>();

function currentSegmentFiles(runId: string, runsDir: string): SegmentFile[] {
  return listOrderedSegments(runId, runsDir).map((file) => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Segment rotated away mid-list; treat as empty/missing.
    }
    return { path: file, size };
  });
}

async function segmentIndex(runId: string, runsDir: string): Promise<SegmentMeta[]> {
  const cacheKey = `${runsDir}\0${runId}`;
  const files = currentSegmentFiles(runId, runsDir);
  const cached = segmentIndexCache.get(cacheKey);
  const previous = new Map<string, SegmentMeta>();
  if (cached) for (const m of cached.meta) previous.set(m.path, m);

  const meta: SegmentMeta[] = files.map((entry) => {
    const prev = previous.get(entry.path);
    if (prev && prev.size === entry.size) return prev;
    if (entry.size === 0) {
      return { ...entry, firstSeq: 0, lastSeq: 0, count: 0, afterCounts: new Map() };
    }
    const { first, last } = probeSegmentRange(entry.path, runId);
    return { ...entry, firstSeq: first, lastSeq: last, count: -1, afterCounts: new Map() };
  });

  segmentIndexCache.delete(cacheKey);
  segmentIndexCache.set(cacheKey, { files, meta });
  if (segmentIndexCache.size > SEGMENT_INDEX_CACHE_MAX) {
    const oldest = segmentIndexCache.keys().next().value;
    if (oldest !== undefined) segmentIndexCache.delete(oldest);
  }
  return meta;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function* readLines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

/** Count a segment's parseable events (async; cached on its index entry). */
async function countSegmentEvents(meta: SegmentMeta, runId: string): Promise<number> {
  if (meta.count >= 0) return meta.count;
  let count = 0;
  let lines = 0;
  try {
    for await (const line of readLines(meta.path)) {
      lines++;
      if (lines % REPLAY_YIELD_EVERY === 0) await yieldToEventLoop();
      if (safeParseEvent(line, runId)) count++;
    }
  } catch {
    // Segment missing/rotated: whatever was counted stays valid.
  }
  meta.count = count;
  return count;
}

/**
 * Count a segment's parseable events with seq > `fromSeq` (async; cached
 * per cursor on its index entry). The probe range answers the easy cases
 * without reading: a segment entirely behind the cursor contributes 0, and
 * one entirely ahead of it contributes its full count.
 */
async function countSegmentEventsAfter(
  meta: SegmentMeta,
  runId: string,
  fromSeq: number,
): Promise<number> {
  const cached = meta.afterCounts.get(fromSeq);
  if (cached !== undefined) return cached;
  let count: number;
  if (meta.count === 0 || (meta.lastSeq > 0 && meta.lastSeq <= fromSeq)) {
    count = 0;
  } else if (meta.firstSeq > fromSeq) {
    count = await countSegmentEvents(meta, runId);
  } else {
    count = 0;
    let lines = 0;
    try {
      for await (const line of readLines(meta.path)) {
        lines++;
        if (lines % REPLAY_YIELD_EVERY === 0) await yieldToEventLoop();
        const event = safeParseEvent(line, runId);
        if (event && event.seq > fromSeq) count++;
      }
    } catch {
      // Segment missing/rotated: whatever was counted stays valid.
    }
  }
  meta.afterCounts.set(fromSeq, count);
  return count;
}

/**
 * Describes where a replay window starts. Reported through
 * `streamRunEventsFrom`'s `onWindow` hook when older events were omitted by
 * `maxEvents`, so the SSE layer can tell a new viewer that it is looking at a
 * truncated tail.
 */
export interface RunReplayWindow {
  truncated: boolean;
  /** Seq of the first event the caller receives. */
  firstSeq: number;
  /** Seq of the newest event in the log at replay time. */
  lastSeq: number;
}

/**
 * Stream a run's persisted events asynchronously in write order (oldest
 * segment first), yielding only events with seq > `fromSeq`. Reading uses
 * `createReadStream` + `readline` and yields to the event loop periodically,
 * so a reconnect never parses the whole log in one blocking pass and never
 * reads segments wholly behind its cursor. `opts.maxEvents` caps how many
 * events are yielded (a new viewer's initial replay): only the newest
 * segments needed to fill the cap are counted, and older segments are skipped
 * without being read. When events were omitted, `opts.onWindow` is called
 * with the window bounds before the first event is yielded.
 */
export async function* streamRunEventsFrom(
  runId: string,
  runsDir: string,
  fromSeq: number,
  options: {
    maxEvents?: number;
    onWindow?: (info: RunReplayWindow) => void;
  } = {},
): AsyncGenerator<SequencedEvent> {
  if (!RUN_ID_RE.test(runId)) return;
  await drainPendingAsync(runId);
  const maxEvents = options.maxEvents ?? Infinity;

  const meta = await segmentIndex(runId, runsDir);

  // Locate the first segment/event of a capped replay by counting only from
  // the newest segment backwards until the cap is filled. Older segments are
  // never counted or read. When a cursor is set, only events after it consume
  // the cap: events at or behind the cursor must neither eat the budget nor
  // report the replay as truncated.
  let startSegment = 0;
  let skipInStart = 0;
  let truncated = false;
  if (maxEvents !== Infinity) {
    let remaining = maxEvents;
    let found = false;
    for (let i = meta.length - 1; i >= 0; i--) {
      const count =
        fromSeq > 0
          ? await countSegmentEventsAfter(meta[i], runId, fromSeq)
          : await countSegmentEvents(meta[i], runId);
      if (count >= remaining) {
        startSegment = i;
        skipInStart = count - remaining;
        found = true;
        break;
      }
      remaining -= count;
    }
    if (!found) {
      // Fewer events than the cap: replay the whole log.
      startSegment = 0;
      skipInStart = 0;
    }
    truncated = startSegment > 0 || skipInStart > 0;
  }
  // Newest seq across segments: the active segment is empty (lastSeq 0)
  // immediately after a rotation, so fall back to the newest segment that
  // actually holds events.
  let newestSeq = 0;
  for (let i = meta.length - 1; i >= 0; i--) {
    if (meta[i].lastSeq > 0) {
      newestSeq = meta[i].lastSeq;
      break;
    }
  }
  let announcedWindow = false;

  let emitted = 0;
  let lastEmittedSeq = fromSeq;
  for (let i = startSegment; i < meta.length; i++) {
    const m = meta[i];
    // Entirely behind the cursor (or empty): no need to open the segment.
    // A non-empty segment whose probe could not determine a range
    // (lastSeq 0, e.g. a trailing event larger than the probe window) must
    // still be read — skipping it would silently drop its events.
    if (m.size === 0 || m.count === 0) continue;
    if (m.lastSeq > 0 && m.lastSeq <= lastEmittedSeq) continue;
    let skip = i === startSegment ? skipInStart : 0;
    let lines = 0;
    try {
      for await (const line of readLines(m.path)) {
        lines++;
        if (lines % REPLAY_YIELD_EVERY === 0) await yieldToEventLoop();
        const event = safeParseEvent(line, runId);
        if (!event) continue;
        if (event.seq <= fromSeq) continue;
        // The cap skip counts only events after the cursor, matching the
        // after-cursor counts used to place the replay window.
        if (skip > 0) {
          skip--;
          continue;
        }
        if (event.seq <= lastEmittedSeq) continue;
        if (truncated && !announcedWindow && options.onWindow) {
          announcedWindow = true;
          options.onWindow({ truncated, firstSeq: event.seq, lastSeq: newestSeq });
        }
        yield event;
        emitted++;
        lastEmittedSeq = event.seq;
        if (emitted >= maxEvents) return;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // Segment rotated away mid-read: re-resolve and continue without
        // dropping events. Skip already-emitted seqs.
        meta.splice(0, meta.length, ...(await segmentIndex(runId, runsDir)));
        i = -1;
        startSegment = 0;
        skipInStart = 0;
        continue;
      }
      // Other read errors: resume with the next segment.
    }
  }
}

/** Distinct runs with a log on disk, newest activity first. */
export function listRunLogs(runsDir: string): RunLogInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const byRun = new Map<string, RunLogInfo>();
  for (const name of names) {
    const match = LOG_NAME_RE.exec(name);
    if (!match) continue;
    const runId = match[1];
    const file = path.join(runsDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const prev = byRun.get(runId);
    if (!prev || mtimeMs > prev.mtimeMs) byRun.set(runId, { runId, file, mtimeMs });
  }
  return [...byRun.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readSegment(file: string, runId: string): SequencedEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: SequencedEvent[] = [];
  let offset = 0;
  let warned = false;
  for (const line of text.split("\n")) {
    const lineOffset = offset;
    // Every split chunk except a trailing one was followed by one "\n" byte.
    offset += Buffer.byteLength(line, "utf8") + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { runId?: unknown }).runId === runId &&
        typeof (parsed as { seq?: unknown }).seq === "number"
      ) {
        events.push(parsed as SequencedEvent);
      }
    } catch {
      // A torn line is an expected artifact of a crash mid-append; it stays in
      // the log but is skipped here. Warn once per segment (at the first torn
      // line) so operators can spot corruption without flooding the logs.
      if (!warned) {
        warned = true;
        console.warn(
          `[telemetry] skipping torn line in ${file} at byte offset ${lineOffset}`,
        );
      }
    }
  }
  return events;
}

/** All persisted events for a run, oldest first, across rotated segments. */
export function readRunEvents(runId: string, runsDir: string): SequencedEvent[] {
  if (!RUN_ID_RE.test(runId)) return [];
  drainPendingSync(runId);
  const base = runLogFile(runsDir, runId);
  const rotated: Array<{ n: number; file: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  for (const name of names) {
    const match = LOG_NAME_RE.exec(name);
    if (!match || match[1] !== runId || !match[2]) continue;
    rotated.push({ n: Number(match[2]), file: path.join(runsDir, name) });
  }
  rotated.sort((a, b) => a.n - b.n);

  // Segments are already in write order (rotated oldest→newest, then the
  // active file), so replay orders by write position alone: a legacy log
  // that already has duplicate seqs from the old eviction bug replays in the
  // order events were actually written (which is also the correct
  // chronology for healthy logs).
  const events: SequencedEvent[] = [];
  for (const segment of rotated) {
    events.push(...readSegment(segment.file, runId));
  }
  events.push(...readSegment(base, runId));
  return events;
}
