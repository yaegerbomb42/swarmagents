import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_THREAD,
  describeRunFailure,
  formatRelativeTime,
  mergeThreadEntries,
  threadReducer,
  type ThreadEntry,
  type ThreadRunInput,
  type ThreadState,
} from "./thread";

const T0 = 1_000_000;

function run(overrides: Partial<ThreadRunInput> & { runId: string }): ThreadRunInput {
  return { createdAt: T0, status: "running", ...overrides };
}

test("builds a chronological thread of prompt + final assistant text", () => {
  const state = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [
      run({ runId: "run_2", prompt: "second", finalText: "reply two", status: "finished", createdAt: T0 + 2000 }),
      run({ runId: "run_1", prompt: "first", finalText: "reply one", status: "finished", createdAt: T0 }),
    ],
  });

  assert.deepEqual(
    state.entries.map((entry) => [entry.runId, entry.prompt, entry.finalText, entry.status]),
    [
      ["run_1", "first", "reply one", "finished"],
      ["run_2", "second", "reply two", "finished"],
    ],
  );
});

test("carries token counts and cost from the run summary through the thread", () => {
  const state = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [
      run({
        runId: "run_1",
        prompt: "build it",
        status: "finished",
        tokensIn: 1200,
        tokensOut: 300,
        tokensCached: 50,
        costUsd: 0.042,
      }),
    ],
  });

  const entry = state.entries[0];
  assert.equal(entry.tokensIn, 1200);
  assert.equal(entry.tokensOut, 300);
  assert.equal(entry.tokensCached, 50);
  assert.equal(entry.costUsd, 0.042);
});

test("token and cost fields are omitted when the run summary lacks them", () => {
  const entries = mergeThreadEntries([], [run({ runId: "run_1", prompt: "p", status: "finished" })]);
  assert.equal(entries[0].tokensIn, undefined);
  assert.equal(entries[0].costUsd, undefined);
  assert.equal(entries[0].tokensReported, false);
});

test("tokensReported persists across fetches and defaults to false", () => {
  const first = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_1", prompt: "p", status: "running" })],
  });
  assert.equal(first.entries[0].tokensReported, false);

  const next = threadReducer(first, {
    type: "merge",
    runs: [run({ runId: "run_1", status: "finished", tokensIn: 5, tokensOut: 1, tokensReported: true })],
  });
  assert.equal(next.entries[0].tokensReported, true);

  // A later poll omitting the flag must not flip it back to false.
  const later = threadReducer(next, {
    type: "merge",
    runs: [run({ runId: "run_1", status: "finished" })],
  });
  assert.equal(later.entries[0].tokensReported, true);
});

test("a later fetch updates the same run in place instead of duplicating it", () => {
  const first = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_1", prompt: "build it" })],
  });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].status, "running");
  assert.equal(first.entries[0].finalText, undefined);

  const done = threadReducer(first, {
    type: "merge",
    runs: [run({ runId: "run_1", finalText: "done, tests pass", status: "finished" })],
  });
  assert.equal(done.entries.length, 1);
  assert.equal(done.entries[0].prompt, "build it");
  assert.equal(done.entries[0].finalText, "done, tests pass");
  assert.equal(done.entries[0].status, "finished");
});

test("omitted fields keep their previous value; error text is carried", () => {
  const first = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_1", prompt: "go", finalText: "partial", sessionId: "s1" })],
  });
  const next = threadReducer(first, {
    type: "merge",
    runs: [{ runId: "run_1", status: "error", error: "claude exited 1" }],
  });
  assert.equal(next.entries[0].finalText, "partial");
  assert.equal(next.entries[0].prompt, "go");
  assert.equal(next.entries[0].sessionId, "s1");
  assert.equal(next.entries[0].status, "error");
  assert.equal(next.entries[0].error, "claude exited 1");
});

test("ignores malformed runs and unknown statuses", () => {
  const state = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [
      { runId: "" },
      null as unknown as ThreadRunInput,
      run({ runId: "run_1", status: "banana", prompt: "p" }),
    ],
  });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].runId, "run_1");
  assert.equal(state.entries[0].status, "running");
});

test("keeps only the most recent runs when over the limit", () => {
  const runs = Array.from({ length: 5 }, (_, i) =>
    run({ runId: `run_${i}`, prompt: `p${i}`, createdAt: T0 + i }),
  );
  const entries = mergeThreadEntries([], runs, 3);
  assert.deepEqual(entries.map((entry) => entry.runId), ["run_2", "run_3", "run_4"]);
});

test("reset clears the thread (new thread)", () => {
  const filled: ThreadState = {
    entries: [{ runId: "run_1", prompt: "p", status: "finished", kind: "agent", createdAt: T0, tokensReported: false }],
  };
  assert.equal(threadReducer(filled, { type: "reset" }), EMPTY_THREAD);
  assert.deepEqual(threadReducer(filled, { type: "reset" }).entries, []);
});

// ---- describeRunFailure (friendly failure display) ----

function failedEntry(overrides: Partial<ThreadEntry> = {}): ThreadEntry {
  return { runId: "run_1", prompt: "p", status: "error", kind: "agent", createdAt: T0, tokensReported: false, ...overrides };
}

test("describeRunFailure: login failure maps to a sign-in title, raw kept for details", () => {
  const display = describeRunFailure(
    failedEntry({ error: "Not logged in · Please run /login" }),
  );
  assert.equal(display?.kind, "auth");
  assert.equal(display?.chip, "failed");
  assert.equal(display?.title, "Not signed in — run /login and retry.");
  assert.equal(display?.raw, "Not logged in · Please run /login");
});

test("describeRunFailure: rejected model maps to the Providers title", () => {
  const display = describeRunFailure(
    failedEntry({ error: "There's an issue with the selected model (clarke-1.0)…" }),
  );
  assert.equal(display?.kind, "model");
  assert.equal(display?.chip, "failed");
  assert.equal(display?.title, "Provider rejected the model — check Providers.");
  assert.equal(display?.raw, "There's an issue with the selected model (clarke-1.0)…");
});

test("describeRunFailure: finished run with no reply text is empty, not failed", () => {
  const display = describeRunFailure(
    failedEntry({ status: "finished", tokensIn: 0, tokensOut: 0 }),
  );
  assert.equal(display?.kind, "empty");
  assert.equal(display?.chip, "empty");
  assert.equal(display?.title, "Run ended with no reply.");
});

test("describeRunFailure: missing result event is an empty run", () => {
  const display = describeRunFailure(
    failedEntry({ error: "claude exited 0 but produced no result event." }),
  );
  assert.equal(display?.kind, "empty");
  assert.equal(display?.chip, "empty");
  assert.equal(display?.title, "Run ended with no reply.");
});

test("describeRunFailure: cancelled runs show the stopped chip", () => {
  const display = describeRunFailure(failedEntry({ status: "cancelled" }));
  assert.equal(display?.kind, "cancelled");
  assert.equal(display?.chip, "stopped");
  assert.equal(display?.title, "Stopped.");
});

test("describeRunFailure: rate limits and overloads get retry titles", () => {
  assert.equal(
    describeRunFailure(failedEntry({ error: "claude exited with code 1: HTTP 429 from gateway" }))?.title,
    "Provider rate-limited — retry in a moment.",
  );
  assert.equal(
    describeRunFailure(failedEntry({ error: "gateway overloaded, retry later" }))?.title,
    "Provider is busy — retry in a moment.",
  );
});

test("describeRunFailure: unknown errors fall back to a generic title with the raw error", () => {
  const display = describeRunFailure(failedEntry({ error: "claude exited with code 1: permission denied" }));
  assert.equal(display?.kind, "unknown");
  assert.equal(display?.chip, "failed");
  assert.equal(display?.title, "Run failed.");
  assert.equal(display?.raw, "claude exited with code 1: permission denied");
});

test("describeRunFailure: returns null for healthy and running entries", () => {
  assert.equal(describeRunFailure(failedEntry({ status: "finished", finalText: "Done." })), null);
  assert.equal(describeRunFailure(failedEntry({ status: "running" })), null);
  assert.equal(describeRunFailure(failedEntry({ status: "error", finalText: "partial reply" })), null);
});

test("formatRelativeTime renders short relative times", () => {
  const now = 1_800_000_000_000;
  assert.equal(formatRelativeTime(now, now), "just now");
  assert.equal(formatRelativeTime(now - 30_000, now), "just now");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeTime(now - 3 * 60 * 60_000, now), "3h ago");
  assert.equal(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now), "2d ago");
  assert.equal(formatRelativeTime(now + 60_000, now), "just now");
});

test("direct terminal execs never become thread entries", () => {
  // A command typed in the terminal's direct-exec input is a shell run: its
  // prompt is the command text and it has no assistant reply. It must stay
  // in the terminal, not appear as a user message with "No response text."
  const state = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [
      run({ runId: "run_shell", prompt: "ls /workspace", kind: "shell", status: "finished", createdAt: T0 }),
      run({ runId: "run_1", prompt: "build it", kind: "agent", finalText: "done", status: "finished", createdAt: T0 + 1000 }),
    ],
  });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].runId, "run_1");
  assert.ok(!state.entries.some((entry) => entry.prompt === "ls /workspace"));
});

test("a previously merged shell entry disappears on the next poll", () => {
  const first = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_shell", prompt: "ls /workspace", status: "finished", createdAt: T0 })],
  });
  assert.equal(first.entries.length, 1);
  const second = threadReducer(first, {
    type: "merge",
    runs: [run({ runId: "run_shell", prompt: "ls /workspace", kind: "shell", status: "finished", createdAt: T0 })],
  });
  assert.equal(second.entries.length, 0);
});

test("runs without a kind (legacy summaries) still list as agent runs", () => {
  const state = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_old", prompt: "old prompt", status: "finished", createdAt: T0 })],
  });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].kind, "agent");
});

test("carries the report meta and finishedAt through merges", () => {
  const report = { status: "finished" as const, steps: 5, shots: 3, artifacts: 2, providers: ["anthropic"] };
  const first = threadReducer(EMPTY_THREAD, {
    type: "merge",
    runs: [run({ runId: "run_1", prompt: "build it", status: "finished", report, finishedAt: T0 + 5000 })],
  });
  assert.equal(first.entries[0].report, report);
  assert.equal(first.entries[0].finishedAt, T0 + 5000);

  // A later merge without a report keeps the previous one.
  const next = threadReducer(first, {
    type: "merge",
    runs: [run({ runId: "run_1", status: "finished" })],
  });
  assert.equal(next.entries[0].report, report);
  assert.equal(next.entries[0].finishedAt, T0 + 5000);
});
