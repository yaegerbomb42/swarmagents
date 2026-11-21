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

function turn(n: number, ts: number, tokens: { cacheRead: number; uncached: number } = { cacheRead: 1000, uncached: 200 }): RunEvent {
  return { type: "turn", turn: n, ts, tokens, ms: 100 };
}

function toolCall(tool: string, ts: number, extra: Record<string, unknown> = {}): RunEvent {
  return { type: "tool.call", tool, ts, ms: 50, ...extra };
}

function readCall(path: string, ts: number): RunEvent {
  return toolCall("read", ts, { input: { files: [{ path, start: 1, end: 1 }] } });
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
