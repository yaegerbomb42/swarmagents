/**
 * Unit tests for the pure run diagnosis (lib/telemetry/run-diagnosis.ts).
 *
 * Synthetic event streams drive each finding kind; a clean stream produces no
 * findings. Acceptance: synthetic streams produce the expected findings, a
 * clean run produces none, and gates stay green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseRun, formatFindings, findingsJson, MAX_FINDINGS, type RunFinding } from "./run-diagnosis";
import type { RunEvent } from "./efficiency";

function turn(
  n: number,
  ts: number,
  tokens: { cacheRead: number; uncached: number; cacheWrite?: number } = { cacheRead: 1000, uncached: 200 },
): RunEvent {
  return { type: "turn", turn: n, ts, tokens, ms: 100 };
}

function toolCall(tool: string, ts: number, extra: Record<string, unknown> = {}): RunEvent {
  return { type: "tool.call", tool, ts, ms: 50, ...extra };
}

function readCall(path: string, ts: number): RunEvent {
  return toolCall("read", ts, { input: { files: [{ path, start: 1, end: 1 }] } });
}

function filePathReadCall(path: string, ts: number): RunEvent {
  return toolCall("read", ts, { input: { file_path: path, start: 1, end: 1 } });
}

function findingOf(events: RunEvent[], kind: string): RunFinding | undefined {
  return diagnoseRun(events).find((f) => f.kind === kind);
}

test("a file read twice with no edit in between is a repeated-read finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    readCall("a.ts", 2000),
    readCall("a.ts", 3000),
  ];
  const f = findingOf(events, "repeated-read");
  assert.ok(f, "expected a repeated-read finding");
  assert.deepEqual(f!.turns, [1]);
});

test("a turn with a single explore call is a single-call-explore finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    readCall("a.ts", 2000),
    turn(2, 3000),
  ];
  const f = findingOf(events, "single-call-explore");
  assert.ok(f, "expected a single-call-explore finding");
  assert.deepEqual(f!.turns, [1]);
});

test("bookkeeping tool share over 30% is a bookkeeping finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    toolCall("todo", 2000),
    toolCall("todo", 2100),
    readCall("a.ts", 2200),
    readCall("b.ts", 2300),
    readCall("c.ts", 2400),
    readCall("d.ts", 2500),
  ];
  const f = findingOf(events, "bookkeeping");
  assert.ok(f, "expected a bookkeeping finding");
  assert.deepEqual(f!.turns, [1]);
});

test("gates over 40% of wall time are a gate-time finding", () => {
  const events: RunEvent[] = [
    turn(1, 0),
    { type: "loop.gates", ts: 4000, ms: 4000 },
    turn(2, 5000),
  ];
  const f = findingOf(events, "gate-time");
  assert.ok(f, "expected a gate-time finding");
  assert.deepEqual(f!.turns, [1]);
});

test("a gap over the idle threshold is an idle finding", () => {
  const events: RunEvent[] = [turn(1, 0), turn(2, 70_000)];
  const f = findingOf(events, "idle");
  assert.ok(f, "expected an idle finding");
  assert.ok(f!.turns.includes(1), "idle turn is reported");
});

test("a tool denial event is a denied finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    { type: "tool.denied", tool: "run", ts: 2000, command: "npm test", reason: "policy" },
  ];
  const f = findingOf(events, "denied");
  assert.ok(f, "expected a denied finding");
  assert.deepEqual(f!.turns, [1]);
  assert.match(f!.hint, /npm test/);
});

test("a read range reported via file_path is tracked as a repeated read", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    filePathReadCall("a.ts", 2000),
    filePathReadCall("a.ts", 3000),
  ];
  const f = findingOf(events, "repeated-read");
  assert.ok(f, "expected a repeated-read finding for a file_path read");
  assert.deepEqual(f!.turns, [1]);
  assert.match(f!.hint, /a\.ts/);
});

test("a read range reported via file_path inside files[] is tracked", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    toolCall("read", 2000, { input: { files: [{ file_path: "b.ts", start: 1, end: 1 }] } }),
    toolCall("read", 3000, { input: { files: [{ file_path: "b.ts", start: 1, end: 1 }] } }),
  ];
  const f = findingOf(events, "repeated-read");
  assert.ok(f, "expected a repeated-read finding for a file_path entry in files[]");
  assert.deepEqual(f!.turns, [1]);
  assert.match(f!.hint, /b\.ts/);
});

test("an edit reported via file_path clears the repeated read for that file", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    readCall("a.ts", 2000),
    toolCall("str_replace", 3000, { input: { file_path: "a.ts" } }),
    readCall("a.ts", 4000),
  ];
  assert.equal(findingOf(events, "repeated-read"), undefined);
});

test("a denial reported by both an error call and a denied event is one finding either way round", () => {
  const deniedCall: RunEvent = { type: "tool.call", tool: "run", ts: 2000, ms: 50, isError: true, error: "denied by policy" };
  const deniedEarly: RunEvent = { type: "tool.denied", tool: "run", ts: 1500, command: "npm test", reason: "policy" };
  const deniedLate: RunEvent = { type: "tool.denied", tool: "run", ts: 3000, command: "npm test", reason: "policy" };
  for (const denied of [deniedEarly, deniedLate]) {
    const found = diagnoseRun([turn(1, 1000), deniedCall, denied]).filter((f) => f.kind === "denied");
    assert.equal(found.length, 1, `expected exactly one denied finding (denied event ts=${denied.ts})`);
    assert.deepEqual(found[0].turns, [1]);
  }
});

test("a cache read under 80% of the previous prompt is a cache-dip finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    turn(2, 2000, { cacheRead: 500, uncached: 200 }),
  ];
  const f = findingOf(events, "cache-dip");
  assert.ok(f, "expected a cache-dip finding");
  assert.deepEqual(f!.turns, [2]);
});

test("a failed str_replace with a not-found error is an edit-miss finding", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    toolCall("str_replace", 2000, { isError: true, error: "snippet not found near line 3", input: { path: "a.ts" } }),
  ];
  const f = findingOf(events, "edit-miss");
  assert.ok(f, "expected an edit-miss finding");
  assert.deepEqual(f!.turns, [1]);
});

test("a clean run produces no findings", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    toolCall("write_file", 1500, { input: { path: "x.ts" } }),
    readCall("a.ts", 1800),
    toolCall("search", 2000, { input: { query: "y" } }),
    turn(2, 2600),
    readCall("b.ts", 3000),
    toolCall("str_replace", 3300, { input: { path: "x.ts" } }),
  ];
  assert.deepEqual(diagnoseRun(events), []);
});

test("at most MAX_FINDINGS findings are returned, worst-score first", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    ...Array.from({ length: 8 }, (_, i) => readCall(`f${i}.ts`, 2000 + i * 100)),
    ...Array.from({ length: 8 }, (_, i) => readCall(`f${i}.ts`, 3000 + i * 100)),
  ];
  const findings = diagnoseRun(events);
  assert.equal(findings.length, MAX_FINDINGS);
  assert.equal(findings[0].kind, "repeated-read");
});

test("formatFindings renders one line per finding, worst first", () => {
  const text = formatFindings([{ kind: "idle", turns: [1, 2], hint: "70s idle." }]);
  assert.equal(text, "1 idle turns 1, 2 70s idle.");
  assert.equal(formatFindings([]), "no findings");
});

test("findingsJson embeds run id and ranked findings", () => {
  const parsed = JSON.parse(findingsJson("run-1", [{ kind: "idle", turns: [1], hint: "70s idle." }])) as {
    run: string;
    findings: { rank: number; kind: string; turns: number[]; hint: string }[];
  };
  assert.equal(parsed.run, "run-1");
  assert.equal(parsed.findings[0].rank, 1);
  assert.equal(parsed.findings[0].kind, "idle");
  assert.deepEqual(parsed.findings[0].turns, [1]);
});


test("read, read, edit still reports the repeated read before the edit clears it", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    readCall("a.ts", 2000),
    readCall("a.ts", 3000),
    toolCall("str_replace", 4000, { input: { path: "a.ts" } }),
  ];
  const f = findingOf(events, "repeated-read");
  assert.ok(f, "the edit must not erase the repeated-read finding");
  assert.deepEqual(f!.turns, [1]);
});

test("multi_edit clears every edited path (top-level and per-edit)", () => {
  const events: RunEvent[] = [
    turn(1, 1000),
    readCall("a.ts", 2000),
    readCall("a.ts", 3000),
    readCall("b.ts", 3500),
    readCall("b.ts", 3600),
    toolCall("multi_edit", 4000, {
      input: { edits: [{ path: "a.ts" }, { path: "b.ts" }] },
    }),
  ];
  const repeated = diagnoseRun(events).filter((f) => f.kind === "repeated-read");
  assert.equal(repeated.length, 2, "both edited paths are cleared");
});

test("turn-1 cacheWrite counts toward the previous prompt for the turn-2 dip", () => {
  const events: RunEvent[] = [
    turn(1, 1000, { cacheRead: 100, uncached: 100, cacheWrite: 1000 }),
    turn(2, 2000, { cacheRead: 100, uncached: 100 }),
  ];
  const f = findingOf(events, "cache-dip");
  assert.ok(f, "a 1000-token cache write makes the next 100-token read a dip");
  assert.deepEqual(f!.turns, [2]);
});

test("mixed explicit and implicit turn numbers never move backwards", () => {
  const events: RunEvent[] = [
    turn(5, 1000),
    { type: "turn", ts: 2000, ms: 100, tokens: { cacheRead: 1000, uncached: 200 } },
    readCall("a.ts", 3000),
    turn(7, 4000),
  ];
  const f = findingOf(events, "single-call-explore");
  assert.ok(f, "expected a single-call-explore finding");
  assert.deepEqual(f!.turns, [6], "the implicit turn after 5 is 6, not 1");
});

test("aggregated repeat findings leave slots for bookkeeping and gates", () => {
  const events: RunEvent[] = [turn(1, 0)];
  for (let i = 1; i <= 6; i++) {
    events.push(turn(i + 1, i * 100));
    events.push(readCall(`f${i}.ts`, i * 100 + 10));
  }
  events.push(toolCall("todo", 800, {}), toolCall("todo", 810, {}), toolCall("todo", 820, {}));
  events.push({ type: "loop.gates", ts: 900, ms: 4000 });
  const kinds = new Set(diagnoseRun(events).map((f) => f.kind));
  assert.ok(kinds.has("single-call-explore"));
  assert.ok(kinds.has("bookkeeping"), "bookkeeping must not be crowded out by explore findings");
  assert.ok(kinds.has("gate-time"), "gate-time must not be crowded out by explore findings");
});
