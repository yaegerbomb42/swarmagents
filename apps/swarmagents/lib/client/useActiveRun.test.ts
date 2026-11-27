import test from "node:test";
import assert from "node:assert/strict";
import {
  LAST_RUN_HINT_KEY,
  RECENT_FINISHED_WINDOW_MS,
  clearLastRunHint,
  loadActiveRun,
  readLastRunHint,
  selectActiveRun,
  writeLastRunHint,
} from "./useActiveRun";
import type { ThreadRunInput } from "./thread";

const NOW = 1_800_000_000_000;

function run(partial: Partial<ThreadRunInput> & { runId: string }): ThreadRunInput {
  return { ...partial };
}

test("selectActiveRun: prefers a running run over a newer finished one", () => {
  const selected = selectActiveRun(
    [
      run({ runId: "run_done", status: "finished", prompt: "done", createdAt: NOW - 60_000, finishedAt: NOW - 30_000 }),
      run({ runId: "run_live", status: "running", prompt: "still going", createdAt: NOW - 120_000 }),
    ],
    NOW,
  );
  assert.equal(selected?.runId, "run_live");
  assert.equal(selected?.active, true);
  assert.equal(selected?.prompt, "still going");
});

test("selectActiveRun: treats queued as active and carries the session id", () => {
  const selected = selectActiveRun(
    [
      run({
        runId: "run_q",
        status: "queued",
        prompt: "waiting",
        createdAt: NOW - 5000,
        sessionId: "sess-1",
      }),
    ],
    NOW,
  );
  assert.deepEqual(selected, {
    runId: "run_q",
    prompt: "waiting",
    sessionId: "sess-1",
    active: true,
    createdAt: NOW - 5000,
  });
});

test("selectActiveRun: selects a finished run inside the 10-minute window", () => {
  const selected = selectActiveRun(
    [
      run({
        runId: "run_new",
        status: "finished",
        prompt: "latest",
        createdAt: NOW - 9 * 60_000,
        finishedAt: NOW - 5 * 60_000,
      }),
    ],
    NOW,
  );
  assert.equal(selected?.runId, "run_new");
  assert.equal(selected?.active, false);
});

test("selectActiveRun: ignores a finished run older than 10 minutes", () => {
  assert.equal(
    selectActiveRun(
      [
        run({
          runId: "run_old",
          status: "finished",
          prompt: "old",
          createdAt: NOW - 30 * 60_000,
          finishedAt: NOW - 11 * 60_000,
        }),
      ],
      NOW,
    ),
    null,
  );
});

test("selectActiveRun: a finished run with no finish time falls back to createdAt", () => {
  assert.equal(
    selectActiveRun(
      [run({ runId: "run_new", status: "finished", prompt: "latest", createdAt: NOW - 5 * 60_000 })],
      NOW,
    )?.runId,
    "run_new",
  );
  assert.equal(
    selectActiveRun(
      [run({ runId: "run_old", status: "error", prompt: "old", createdAt: NOW - RECENT_FINISHED_WINDOW_MS - 1000 })],
      NOW,
    ),
    null,
  );
});

test("selectActiveRun: skips shell runs and returns null when nothing qualifies", () => {
  assert.equal(
    selectActiveRun([run({ runId: "sh-1", status: "running", kind: "shell", createdAt: NOW - 1000 })], NOW),
    null,
  );
  assert.equal(selectActiveRun([], NOW), null);
});

test("last-run hint: round-trips through sessionStorage and tolerates its absence", () => {
  const previous = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  try {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage: unknown }).sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    assert.equal(readLastRunHint(), undefined);
    writeLastRunHint("run-123");
    assert.equal(readLastRunHint(), "run-123");
    assert.equal(store.get(LAST_RUN_HINT_KEY), "run-123");
    clearLastRunHint();
    assert.equal(readLastRunHint(), undefined);
  } finally {
    if (previous === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else (globalThis as { sessionStorage: unknown }).sessionStorage = previous;
  }
  // Without sessionStorage (plain node) the helpers are no-ops, not throws.
  assert.equal(readLastRunHint(), undefined);
  writeLastRunHint("run-123");
  clearLastRunHint();
});

test("loadActiveRun: selects from the fetched runs and returns null on a 503", async () => {
  const okFetch = (async () =>
    new Response(
      JSON.stringify({
        runs: [
          { runId: "run_live", status: "running", prompt: "go", createdAt: NOW - 1000, sessionId: "sess-9" },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  assert.deepEqual(await loadActiveRun(okFetch, NOW), {
    runId: "run_live",
    prompt: "go",
    sessionId: "sess-9",
    active: true,
    createdAt: NOW - 1000,
  });

  const failingFetch = (async () =>
    new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })) as unknown as typeof fetch;
  assert.equal(await loadActiveRun(failingFetch, NOW), null);
});
