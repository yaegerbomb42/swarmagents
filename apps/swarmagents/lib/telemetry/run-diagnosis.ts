/**
 * Pure run diagnosis ported from vendor/omnexx/src/telemetry/run-diagnosis.ts
 * (the version with the Omnexx modifications; the engine's copy imports a
 * src/telemetry/efficiency.js that does not exist in the vendor tree).
 *
 * Only the pure, deterministic pieces are extracted: `diagnoseRun`,
 * `formatFindings`, `findingsJson`, and their supporting logic. There is no
 * wiring into the run report in this PR (that is a separate decision).
 */
import { BOOKKEEPING_TOOLS, IDLE_GAP_MS, coveredMs, efficiency, type RunEvent } from "./efficiency";

/** Look-around tools. One of these alone is a wasted round trip (see the agent loop). */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "outline",
  "search",
  "list",
  "read_symbol",
]);

/** Writes that change a file, so a later read of it is not a repeat of an unchanged range. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "str_replace",
  "multi_edit",
  "write_file",
  "replace_lines",
]);

const EDIT_MISS_TOOLS: ReadonlySet<string> = new Set(["str_replace", "multi_edit"]);

/** Bookkeeping is a problem once it is at least this share of tool calls. */
const BOOKKEEPING_SHARE = 0.3;
/** Gates are a problem once they are at least this share of the run's wall time. */
const GATE_SHARE = 0.4;
/** A later turn whose cache read is under this fraction of the previous prompt. */
const CACHE_OF_PREVIOUS = 0.8;

export const MAX_FINDINGS = 5;

export type FindingKind =
  | "single-call-explore"
  | "repeated-read"
  | "bookkeeping"
  | "gate-time"
  | "idle"
  | "cache-dip"
  | "denied"
  | "edit-miss";

export interface RunFinding {
  kind: FindingKind;
  turns: number[];
  hint: string;
}

interface Scored extends RunFinding {
  score: number;
}

interface Range {
  path: string;
  start: number | undefined;
  end: number | undefined;
}

interface EditMiss {
  turn: number;
  error: string;
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function callInput(e: RunEvent): Record<string, unknown> | undefined {
  const raw = e.input;
  const direct = recordOf(raw);
  if (direct) return direct;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.endsWith("…") ? raw.slice(0, -1) : raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return recordOf(parsed);
  } catch {
    return undefined;
  }
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The edited/read file from a tool input. Prefer `path`; fall back to
 * `file_path` when `path` is absent or empty — some tool inputs report the
 * file under `file_path`.
 */
function inputPath(o: Record<string, unknown> | undefined): string | undefined {
  if (!o) return undefined;
  if (typeof o.path === "string" && o.path.length > 0) return o.path;
  if (typeof o.file_path === "string" && o.file_path.length > 0) return o.file_path;
  return undefined;
}

function oneRange(o: Record<string, unknown>): Range | undefined {
  const p = inputPath(o);
  if (p === undefined) return undefined;
  return { path: p, start: finite(o.start), end: finite(o.end) };
}

function readRanges(e: RunEvent): Range[] {
  const input = callInput(e);
  if (!input) return [];
  if (!Array.isArray(input.files)) {
    const range = oneRange(input);
    return range ? [range] : [];
  }
  const out: Range[] = [];
  for (const file of input.files) {
    const rec = recordOf(file);
    const range = rec ? oneRange(rec) : undefined;
    if (range) out.push(range);
  }
  return out;
}

function rangeKey(r: Range): string {
  return `${r.path}\0${r.start ?? "*"}\0${r.end ?? "*"}`;
}

function rangeLabel(key: string): string {
  const [path = "", start = "*", end = "*"] = key.split("\0");
  if (start === "*" && end === "*") return path;
  if (start === "*") return `${path}:-${end}`;
  if (end === "*") return `${path}:${start}-`;
  return `${path}:${start}-${end}`;
}

function toolName(e: RunEvent): string {
  return typeof e.tool === "string" ? e.tool : "";
}

function errorText(e: RunEvent): string {
  return typeof e.error === "string" ? e.error : "";
}

function clip(s: string, max = 100): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function uniqueTurns(turns: readonly number[]): number[] {
  const out: number[] = [];
  for (const n of turns) if (n > 0 && !out.includes(n)) out.push(n);
  return out;
}

function token(e: RunEvent, key: "cacheRead" | "uncached" | "cacheWrite"): number | undefined {
  const tokens = recordOf(e.tokens);
  return tokens ? finite(tokens[key]) : undefined;
}

function explicitTurn(e: RunEvent): number | undefined {
  return typeof e.turn === "number" && Number.isFinite(e.turn) ? e.turn : undefined;
}

function dropPath(reads: Map<string, number[]>, path: string | undefined): void {
  if (!path) return;
  const prefix = `${path}\0`;
  for (const key of reads.keys()) if (key.startsWith(prefix)) reads.delete(key);
}

function denialHint(e: RunEvent, tool: string): string {
  const command = typeof e.command === "string" ? e.command : "";
  const reason =
    typeof e.reason === "string" ? e.reason : typeof e.rule === "string" ? e.rule : errorText(e);
  const what = command ? `\`${clip(command, 60)}\`` : tool || "command";
  const why = clip(reason || "policy", 80);
  return `${what} was refused (${why}). Change the command or ask before running it.`;
}

function isDenialCall(e: RunEvent): boolean {
  return e.isError === true && /refus|denied/i.test(errorText(e));
}

function editMissFinding(misses: readonly EditMiss[]): Scored | undefined {
  if (!misses.length) return undefined;
  const named = misses.some((m) => /not found/i.test(m.error));
  if (!named && misses.length < 2) return undefined;
  const hint = named
    ? "str_replace failed because the snippet was not found. Re-read the file and match the text that is there now."
    : "Repeated failed str_replace calls; the log has no separate edit-miss event. Re-read the file and match the text that is there now.";
  return {
    kind: "edit-miss",
    turns: uniqueTurns(misses.map((m) => m.turn)),
    hint,
    score: 40_000 + misses.length * 1_000,
  };
}

function repeatedReadFindings(reads: ReadonlyMap<string, number[]>): Scored[] {
  const out: Scored[] = [];
  for (const [key, turns] of reads) {
    const listed = uniqueTurns(turns);
    if (turns.length < 2 || listed.length === 0) continue;
    out.push({
      kind: "repeated-read",
      turns: listed,
      hint: `${rangeLabel(key)} was read again with no edit in between. Reuse the earlier result.`,
      score: 100_000 + (turns.length - 1) * 1_000,
    });
  }
  return out;
}

/**
 * Worst problems in one finished run, at most {@link MAX_FINDINGS}. Shares and idle time come
 * from `efficiency()`; turn numbers are read off the same events.
 */
export function diagnoseRun(events: readonly RunEvent[]): RunFinding[] {
  const sorted = [...events].filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const eff = efficiency(sorted);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!eff || !first || !last) return [];

  const findings: Scored[] = [];
  const reads = new Map<string, number[]>();
  const misses: EditMiss[] = [];
  const bookTurns: number[] = [];
  const gateTurns: number[] = [];
  const idleTurns: number[] = [];
  /** Aggregated per-turn findings: one slot each, so they cannot crowd out other kinds. */
  const exploreTurns: number[] = [];
  const exploreTools = new Map<string, number>();
  const cacheDipTurns: number[] = [];
  const deniedTurns: number[] = [];
  const deniedHints: string[] = [];
  /** turn:tool pairs already reported as denied, from either a `tool.denied` event or an error `tool.call`, so the matching pair is never counted twice regardless of event order. */
  const deniedTools = new Set<string>();
  let activeTurn = 0;
  let seq = 0;
  let calls: string[] = [];
  let openTurn = false;
  let seenTurn = false;
  let prevPrompt: number | undefined;
  let prevTs = first.ts;

  const flush = (): void => {
    const only = calls.length === 1 ? calls[0] : undefined;
    if (openTurn && activeTurn > 0 && only !== undefined && EXPLORE_TOOLS.has(only)) {
      exploreTurns.push(activeTurn);
      exploreTools.set(only, (exploreTools.get(only) ?? 0) + 1);
    }
    calls = [];
    openTurn = false;
  };

  for (const e of sorted) {
    const open = e.ts - prevTs - coveredMs(e);
    const upcoming = e.type === "turn" ? (explicitTurn(e) ?? seq + 1) : activeTurn;
    if (open > IDLE_GAP_MS) {
      if (activeTurn > 0) idleTurns.push(activeTurn);
      if (upcoming > 0) idleTurns.push(upcoming);
    }
    prevTs = e.ts;

    if (e.type === "turn") {
      flush();
      const n = explicitTurn(e);
      if (n === undefined) seq += 1;
      else seq = Math.max(seq, n);
      activeTurn = n ?? seq;
      openTurn = true;
      const cacheRead = token(e, "cacheRead");
      const uncached = token(e, "uncached");
      const cacheWrite = token(e, "cacheWrite");
      if (
        seenTurn &&
        cacheRead !== undefined &&
        uncached !== undefined &&
        prevPrompt !== undefined &&
        prevPrompt > 0 &&
        cacheRead < prevPrompt * CACHE_OF_PREVIOUS
      ) {
        cacheDipTurns.push(activeTurn);
      }
      seenTurn = true;
      prevPrompt =
        cacheRead !== undefined && uncached !== undefined
          ? cacheRead + uncached + (cacheWrite ?? 0)
          : undefined;
    } else if (e.type === "tool.call") {
      const tool = toolName(e);
      calls.push(tool);
      if (BOOKKEEPING_TOOLS.has(tool)) bookTurns.push(activeTurn);
      if (tool === "read") {
        for (const range of readRanges(e)) {
          const key = rangeKey(range);
          const prior = reads.get(key) ?? [];
          prior.push(activeTurn);
          reads.set(key, prior);
        }
      }
      if (EDIT_TOOLS.has(tool) && e.isError !== true) {
        // Snapshot the repeated-read finding before the edit clears the path:
        // read, read, edit must still report the wasted second read.
        for (const path of editedPaths(e)) {
          const prefix = `${path}\0`;
          const pending = new Map<string, number[]>();
          for (const [key, turns] of reads) if (key.startsWith(prefix)) pending.set(key, [...turns]);
          findings.push(...repeatedReadFindings(pending));
          dropPath(reads, path);
        }
      }
      if (EDIT_MISS_TOOLS.has(tool) && e.isError === true)
        misses.push({ turn: activeTurn, error: errorText(e) });
      if (isDenialCall(e) && !deniedTools.has(`${activeTurn}:${tool}`)) {
        // Record the pair here too: otherwise a later `tool.denied` event
        // for the same turn:tool would report the same denial a second time.
        deniedTools.add(`${activeTurn}:${tool}`);
        deniedTurns.push(activeTurn);
        deniedHints.push(denialHint(e, tool));
      }
    } else if (e.type === "tool.denied") {
      const tool = toolName(e) || "command";
      const key = `${activeTurn}:${tool}`;
      if (!deniedTools.has(key)) {
        deniedTools.add(key);
        deniedTurns.push(activeTurn);
        deniedHints.push(denialHint(e, tool));
      }
    } else if (e.type === "loop.gates" || e.type === "verify.gates") {
      gateTurns.push(activeTurn);
    }
  }
  flush();

  if (exploreTurns.length) {
    const topTool =
      [...exploreTools.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "look-around";
    findings.push({
      kind: "single-call-explore",
      turns: uniqueTurns(exploreTurns),
      hint:
        exploreTurns.length === 1
          ? `One ${topTool} call on this turn. Send every read, search, and outline you need in the same turn.`
          : `${exploreTurns.length} turns had a single look-around call (mostly ${topTool}). Batch every read, search, and outline into the turn that needs them.`,
      score: 20_000 + (exploreTurns.length - 1) * 100,
    });
  }

  if (cacheDipTurns.length) {
    findings.push({
      kind: "cache-dip",
      turns: uniqueTurns(cacheDipTurns),
      hint:
        cacheDipTurns.length === 1
          ? "Cache read was under 80% of the previous prompt. Keep the prefix stable so the cache hits."
          : `Cache read dipped under 80% of the previous prompt on ${cacheDipTurns.length} turns. Keep the prompt prefix stable so the cache hits.`,
      score: 30_000 + (cacheDipTurns.length - 1) * 100,
    });
  }

  if (deniedTurns.length) {
    findings.push({
      kind: "denied",
      turns: uniqueTurns(deniedTurns),
      hint:
        deniedHints.length === 1
          ? deniedHints[0]
          : `${deniedHints.length} calls were refused. First: ${deniedHints[0]}`,
      score: 5_000 + (deniedTurns.length - 1) * 100,
    });
  }

  findings.push(...repeatedReadFindings(reads));
  const miss = editMissFinding(misses);
  if (miss) findings.push(miss);

  if (eff.bookkeeping_share >= BOOKKEEPING_SHARE) {
    const pct = Math.round(eff.bookkeeping_share * 100);
    findings.push({
      kind: "bookkeeping",
      turns: uniqueTurns(bookTurns),
      hint: `${pct}% of tool calls only kept notes. Send todo, running_context, remember, context, and recall with the work of the same turn.`,
      score: 8_000 + eff.bookkeeping_share * 1_000,
    });
  }

  const wall = last.ts - first.ts;
  if (wall > 0 && eff.gate_ms / wall >= GATE_SHARE) {
    const pct = Math.round((eff.gate_ms / wall) * 100);
    const secs = Math.round(eff.gate_ms / 1000);
    findings.push({
      kind: "gate-time",
      turns: uniqueTurns(gateTurns),
      hint: `Gates took ${pct}% of the run (${secs}s). Run the related tests first.`,
      score: 7_000 + (eff.gate_ms / wall) * 1_000,
    });
  }

  if (eff.idle_ms > 0) {
    const secs = Math.round(eff.idle_ms / 1000);
    findings.push({
      kind: "idle",
      turns: uniqueTurns(idleTurns),
      hint: `${secs}s idle: a gap over 60s that no turn, tool, or gate covers.`,
      score: 1_000_000 + eff.idle_ms,
    });
  }

  return findings
    .sort(
      (a, b) =>
        b.score - a.score || (a.turns[0] ?? 0) - (b.turns[0] ?? 0) || a.kind.localeCompare(b.kind),
    )
    .slice(0, MAX_FINDINGS)
    .map(({ kind, turns, hint }) => ({ kind, turns, hint }));
}

/**
 * Every path an edit tool touched. `multi_edit` usually carries a top-level
 * path, but models also repeat the path inside `edits`; a multi-file edit may
 * use `files`. Accept all three rather than clearing the wrong (or no) path.
 * Each level accepts `file_path` as well as `path` (see inputPath).
 */
function editedPaths(e: RunEvent): string[] {
  const input = callInput(e);
  if (!input) return [];
  const paths: string[] = [];
  const top = inputPath(input);
  if (top) paths.push(top);
  for (const collection of [input.files, input.edits]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const p = inputPath(recordOf(entry));
      if (p) paths.push(p);
    }
  }
  return [...new Set(paths)];
}

/** Plain-text report: rank, kind, turns, hint. One line each, worst first. */
export function formatFindings(findings: readonly RunFinding[]): string {
  if (!findings.length) return "no findings";
  return findings
    .map((f, i) => {
      const turns = f.turns.length ? f.turns.join(", ") : "none";
      return `${i + 1} ${f.kind} turns ${turns} ${f.hint}`;
    })
    .join("\n");
}

export function findingsJson(run: string, findings: readonly RunFinding[]): string {
  return JSON.stringify(
    {
      run,
      findings: findings.map((f, i) => ({
        rank: i + 1,
        kind: f.kind,
        turns: f.turns,
        hint: f.hint,
      })),
    },
    null,
    2,
  );
}
