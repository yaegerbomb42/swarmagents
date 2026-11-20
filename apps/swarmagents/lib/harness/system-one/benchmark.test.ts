/**
 * Acceptance: turns-per-task drops on benchmark tasks vs the pre-System-1
 * harness, without stopping runs that are not done.
 *
 * The trajectories are realistic recorded shapes of Claude Code runs (the
 * agent verifies green, then keeps re-reading and re-running checks before
 * it finally stops on its own). Replay is deterministic and offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { replayBaseline, replayWithSystemOne, type Trajectory } from "./benchmark";
import { SystemOneHooks } from "./hooks";
import type { SystemOneScorer } from "./scorer";

const DONE_TEXT =
  "The off-by-one in parseRange is fixed and the regression test passes; the full suite is green and nothing else needs to change.";

const fixBug: Trajectory = {
  name: "fix-off-by-one",
  prompt: "Fix the off-by-one bug in parseRange so the failing range test passes.",
  turns: [
    { assistantText: "Searching for parseRange.", calls: [{ name: "Grep", input: { pattern: "parseRange" }, isError: false }] },
    { assistantText: "Reading the implementation.", calls: [{ name: "Read", input: { file_path: "lib/range.ts" }, isError: false }] },
    { assistantText: "The loop bound is wrong.", calls: [{ name: "Edit", input: { file_path: "lib/range.ts", old_string: "i <= end", new_string: "i < end" }, isError: false }] },
    { assistantText: "Running the tests.", calls: [{ name: "Bash", input: { command: "npm test -- lib/range.test.ts" }, isError: false, output: "ok 1 - range\n# pass 1\n# fail 0" }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Read", input: { file_path: "lib/range.ts" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Bash", input: { command: "git diff" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Read", input: { file_path: "lib/range.test.ts" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Bash", input: { command: "npm test" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [] },
  ],
};

const explain: Trajectory = {
  name: "explain-session-cookie",
  prompt: "Where is the session cookie set and how long does it live?",
  turns: [
    { assistantText: "Looking for the cookie.", calls: [{ name: "Grep", input: { pattern: "SESSION_COOKIE" }, isError: false }] },
    {
      assistantText:
        "The session cookie is set in app/api/login/route.ts via setCookie(SESSION_COOKIE, token, { httpOnly: true, maxAge: 60 * 60 * 24 * 30 }), so it lives for 30 days. Signup sets the same cookie in app/api/signup/route.ts. It is HttpOnly and SameSite=Lax, and the value is an opaque session id.",
      calls: [{ name: "Read", input: { file_path: "app/api/login/route.ts" }, isError: false }],
    },
    { assistantText: "Double-checking signup.", calls: [{ name: "Read", input: { file_path: "app/api/signup/route.ts" }, isError: false }] },
    { assistantText: "And the middleware.", calls: [{ name: "Read", input: { file_path: "middleware.ts" }, isError: false }] },
    { assistantText: "Checking constants.", calls: [{ name: "Grep", input: { pattern: "maxAge" }, isError: false }] },
    { assistantText: "That's the full answer above.", calls: [] },
  ],
};

const notDone: Trajectory = {
  name: "still-red",
  prompt: "Fix the flaky upload test.",
  turns: [
    { assistantText: "Editing.", calls: [{ name: "Edit", input: { file_path: "lib/upload.ts" }, isError: false }] },
    { assistantText: "Testing.", calls: [{ name: "Bash", input: { command: "npm test" }, isError: true }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Read", input: { file_path: "lib/upload.ts" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Read", input: { file_path: "lib/upload.test.ts" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [{ name: "Read", input: { file_path: "lib/upload.test.ts" }, isError: false }] },
    { assistantText: "Fixing the race.", calls: [{ name: "Edit", input: { file_path: "lib/upload.ts" }, isError: false }] },
    { assistantText: "Testing again.", calls: [{ name: "Bash", input: { command: "npm test" }, isError: false }] },
    { assistantText: DONE_TEXT, calls: [] },
  ],
};

test("acceptance: turns-per-task drops vs the pre-System-1 harness", async () => {
  const rows: string[] = [];
  let baselineTotal = 0;
  let systemOneTotal = 0;
  for (const t of [fixBug, explain, notDone]) {
    const base = replayBaseline(t);
    const s1 = await replayWithSystemOne(t, new SystemOneHooks({ settings: { enabled: true } }));
    baselineTotal += base.turns;
    systemOneTotal += s1.turns;
    rows.push(`${t.name}: baseline ${base.turns} turns → system-1 ${s1.turns} turns${s1.stoppedEarly ? " (early stop)" : ""}`);
    assert.ok(s1.turns <= base.turns);
  }
  rows.push(`total: ${baselineTotal} → ${systemOneTotal} turns (-${Math.round((1 - systemOneTotal / baselineTotal) * 100)}%)`);
  for (const row of rows) console.log(`turns-per-task ${row}`);

  const fix = await replayWithSystemOne(fixBug, new SystemOneHooks({ settings: { enabled: true } }));
  assert.equal(fix.turns, 6, "stops once green + two re-inspections");
  assert.equal(fix.stoppedEarly, true);
  assert.equal(fix.closingReply, `${DONE_TEXT}\n\nDone. Changed lib/range.ts; the checks passed after the last edit.`);

  const ex = await replayWithSystemOne(explain, new SystemOneHooks({ settings: { enabled: true } }));
  assert.equal(ex.turns, 3, "answered on turn 2, stopped after the second re-read");
  assert.match(ex.closingReply ?? "", /^The session cookie is set in app\/api\/login\/route\.ts/);

  // A run that is not done (tests went red) is never cut short.
  const red = await replayWithSystemOne(notDone, new SystemOneHooks({ settings: { enabled: true } }));
  assert.equal(red.turns, notDone.turns.length);
  assert.equal(red.stoppedEarly, false);

  assert.ok(systemOneTotal < baselineTotal);
});

test("with System-1 disabled, or with a broken scorer, the replay matches the baseline exactly", async () => {
  const broken: SystemOneScorer = {
    backend: "broken",
    destructive: () => {
      throw new Error("x");
    },
    patch: () => {
      throw new Error("x");
    },
    triage: () => {
      throw new Error("x");
    },
    completion: () => {
      throw new Error("x");
    },
    intent: () => {
      throw new Error("x");
    },
  };
  for (const t of [fixBug, explain, notDone]) {
    const off = await replayWithSystemOne(t, new SystemOneHooks());
    assert.equal(off.turns, t.turns.length);
    const failing = await replayWithSystemOne(t, new SystemOneHooks({ settings: { enabled: true }, scorer: broken }));
    assert.equal(failing.turns, t.turns.length, `${t.name}: fail-open keeps the baseline behaviour`);
    assert.ok(failing.verdicts.every((v) => v.verdict.action === "allow"));
  }
});
