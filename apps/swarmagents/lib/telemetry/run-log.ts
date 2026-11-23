import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { SequencedEvent } from "./bus";
import { RUN_ID_RE } from "./paths";

export const MAX_RUN_LOG_BYTES = 5 * 1024 * 1024;

const LOG_NAME_RE = /^([A-Za-z0-9_-]{1,64})\.jsonl(?:\.(\d+))?$/;

/** Yield to the event loop this often while streaming a segment. */
const REPLAY_YIELD_EVERY = 512;
/** New-viewer replay is capped to the most recent events for responsiveness. */
export const INITIAL_REPLAY_CAP = 2000;
/** Bytes read from the head of a segment to probe its first seq. */
const PROBE_HEAD_BYTES = 4096;
/** Segment-index cache entries kept before the oldest run is evicted. */
const SEGMENT_INDEX_CACHE_MAX = 512;

export function runLogFile(runsDir: string, runId: string): string {
  return path.join(runsDir, `${runId}.jsonl`);
}

function rotationFile(base: string): string {
  let n = 1;
  while (fs.existsSync(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
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

/**
 * Append one event as a JSON line. Before writing, the active file is repaired
 * to end on a newline (see `ensureLineBoundary`); the same guarantee applies
 * when the file rotates, so every rotated segment ends on a line boundary
 * too. The active file rotates to `<runId>.jsonl.<n>` once it would exceed
 * `maxBytes`, keeping writes bounded without losing older events (replay reads
 * every segment).
 */
export function appendRunEvent(
  event: SequencedEvent,
  runsDir: string,
  maxBytes: number = MAX_RUN_LOG_BYTES,
): void {
  if (!RUN_ID_RE.test(event.runId)) return;
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  const file = runLogFile(runsDir, event.runId);
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // No active file yet.
    }
    size = ensureLineBoundary(file, size);
    if (size > 0 && size + bytes > maxBytes) {
      const rotated = rotationFile(file);
      fs.renameSync(file, rotated);
      // The segment was repaired above, so it ends on a line boundary before
      // it is frozen; the fresh active file starts empty.
      rememberFramed(rotated, size);
      framedSizes.delete(file);
      size = 0;
    }
    fs.appendFileSync(file, line, "utf8");
    rememberFramed(file, size + bytes);
  } catch (err) {
    // A partial/failed write (e.g. ENOSPC) may have left the file mid-line:
    // drop the cached frame so the next append re-checks the last byte
    // instead of trusting a size that now matches a torn tail.
    framedSizes.delete(file);
    // Telemetry persistence must never break a live run.
    console.error(`[telemetry] could not persist event for ${event.runId}:`, err);
  }
}

export interface RunLogInfo {
  runId: string;
  file: string;
  mtimeMs: number;
}

/**
 * fsync every run-log segment on disk so in-flight telemetry reaches durable
 * storage before the process exits. Appends are synchronous today, so this
 * only flushes OS buffers — but it is the seam a future buffered writer must
 * implement, and it is what the shutdown handler calls. Best-effort: a
 * missing or rotated file is skipped, never thrown.
 */
export function flushRunLogs(runsDir: string | null): void {
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
      fd = fs.openSync(file, "r");
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
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
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
  for (let i = startSegment; i < meta.length; i++) {
    const m = meta[i];
    // Entirely behind the cursor (or empty): no need to open the segment.
    // A non-empty segment whose probe could not determine a range
    // (lastSeq 0, e.g. a trailing event larger than the probe window) must
    // still be read — skipping it would silently drop its events.
    if (m.size === 0 || m.count === 0) continue;
    if (m.lastSeq > 0 && m.lastSeq <= fromSeq) continue;
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
        if (truncated && !announcedWindow && options.onWindow) {
          announcedWindow = true;
          options.onWindow({ truncated, firstSeq: event.seq, lastSeq: newestSeq });
        }
        yield event;
        emitted++;
        if (emitted >= maxEvents) return;
      }
    } catch {
      // A segment rotated away mid-stream: resume with the next one.
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
