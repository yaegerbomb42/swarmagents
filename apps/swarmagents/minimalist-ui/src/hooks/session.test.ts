import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEntry, makeTask } from "../testing/harness";
import { pickActiveRunId, resolveStopTarget, runsInThread, sessionToContinue, stabilizeEntries } from "./useAgentSession";
import { countTasks, upsertTask } from "./useBoard";
import { countUsableProviders } from "./useEnvironment";

test("the active run is the one running, else the queued run that starts next", () => {
  // Newest first, as the runs route returns them.
  assert.equal(pickActiveRunId([]), undefined);
  assert.equal(pickActiveRunId([{ runId: "c", status: "finished" }]), undefined);
  assert.equal(
    pickActiveRunId([
      { runId: "c", status: "queued" },
      { runId: "b", status: "running" },
      { runId: "a", status: "finished" },
    ]),
    "b",
  );
  assert.equal(
    pickActiveRunId([
      { runId: "c", status: "queued" },
      { runId: "b", status: "queued" },
    ]),
    "b",
    "the oldest queued run starts first",
  );
  assert.equal(pickActiveRunId([{ runId: "s", status: "running", kind: "shell" }]), undefined, "terminal commands are not agent runs");
});

test("a conversation is its session's runs plus the runs started from this page", () => {
  const entries = [
    makeEntry({ runId: "run_1", sessionId: "sess_a" }),
    makeEntry({ runId: "run_2", sessionId: "sess_b" }),
    makeEntry({ runId: "run_3", sessionId: "sess_a" }),
    makeEntry({ runId: "run_4" }),
  ];

  assert.deepEqual(runsInThread(entries, "sess_a", []).map((entry) => entry.runId), ["run_1", "run_3"]);
  assert.deepEqual(runsInThread(entries, "run_4", []).map((entry) => entry.runId), ["run_4"], "a thread can be keyed by its first run");
  assert.deepEqual(runsInThread(entries, "", []), [], "a new chat is empty");
  assert.deepEqual(
    runsInThread(entries, "", ["run_4"]).map((entry) => entry.runId),
    ["run_4"],
    "a run just sent shows before the server names its session",
  );
});

test("a follow-up continues the newest session the conversation knows", () => {
  assert.equal(sessionToContinue([]), undefined);
  assert.equal(sessionToContinue([makeEntry({ runId: "a" })]), undefined);
  assert.equal(
    sessionToContinue([makeEntry({ runId: "a", sessionId: "sess_1" }), makeEntry({ runId: "b", sessionId: "sess_2" }), makeEntry({ runId: "c" })]),
    "sess_2",
  );
});

test("a poll that changes nothing keeps every object, so no turn re-renders", () => {
  const prev = [makeEntry({ runId: "a" }), makeEntry({ runId: "b", status: "running" })];
  const same = stabilizeEntries(prev, [makeEntry({ runId: "a" }), makeEntry({ runId: "b", status: "running" })]);
  assert.equal(same, prev, "the same array comes back");

  const next = stabilizeEntries(prev, [makeEntry({ runId: "a" }), makeEntry({ runId: "b", status: "finished", finalText: "Done." })]);
  assert.notEqual(next, prev);
  assert.equal(next[0], prev[0], "the untouched run keeps its object");
  assert.notEqual(next[1], prev[1]);
  assert.equal(next[1].finalText, "Done.");

  const grown = stabilizeEntries(prev, [...prev.map((entry) => ({ ...entry })), makeEntry({ runId: "c" })]);
  assert.equal(grown.length, 3);
  assert.equal(grown[0], prev[0]);
  assert.equal(grown[1], prev[1]);
});

test("a run's report counts are compared by value", () => {
  const report = { status: "finished", steps: 3, shots: 1, artifacts: 2, durationMs: 1000 };
  const prev = [makeEntry({ runId: "a", report: { ...report } as never })];
  assert.equal(stabilizeEntries(prev, [makeEntry({ runId: "a", report: { ...report } as never })]), prev);
  const changed = stabilizeEntries(prev, [makeEntry({ runId: "a", report: { ...report, artifacts: 3 } as never })]);
  assert.notEqual(changed[0], prev[0]);
});

test("board counts come from the tasks, and an updated task replaces its row", () => {
  const tasks = [
    makeTask({ id: "a", status: "open" }),
    makeTask({ id: "b", status: "claimed" }),
    makeTask({ id: "c", status: "in_review" }),
    makeTask({ id: "d", status: "completed" }),
    makeTask({ id: "e", status: "open" }),
  ];
  assert.deepEqual(countTasks(tasks), { tasks: 5, open: 2, claimed: 1, in_review: 1, completed: 1 });

  const claimed = makeTask({ id: "a", status: "claimed", claimedBy: "alice (VM)" });
  const updated = upsertTask(tasks, claimed);
  assert.equal(updated.length, 5);
  assert.equal(updated[0], claimed);
  assert.equal(tasks[0].status, "open", "the input is not mutated");

  const added = upsertTask(tasks, makeTask({ id: "new" }));
  assert.deepEqual(added.map((task) => task.id), ["new", "a", "b", "c", "d", "e"]);
});

test("a provider counts only when it has a key and is switched on", () => {
  assert.equal(countUsableProviders([]), 0);
  assert.equal(
    countUsableProviders([
      { keyCount: 2, enabled: true },
      { keyCount: 1 },
      { keyCount: 0, enabled: true },
      { keyCount: 3, enabled: false },
      { keyCount: "2" },
    ]),
    2,
  );
});

test("Stop acts on the named run, else the active run, else the run a send in flight is creating", async () => {
  assert.deepEqual(await resolveStopTarget("named", "active", null), { kind: "run", runId: "named" });
  assert.deepEqual(await resolveStopTarget(undefined, "active", null), { kind: "run", runId: "active" });
  assert.deepEqual(await resolveStopTarget(undefined, undefined, null), { kind: "none" });

  // Stop pressed before the server has answered the send: it waits for the run.
  let created: (result: { ok: true; runId: string }) => void = () => undefined;
  const sending = new Promise<{ ok: true; runId: string }>((resolve) => {
    created = resolve;
  });
  let settled = false;
  const target = resolveStopTarget(undefined, undefined, sending).then((found) => {
    settled = true;
    return found;
  });
  await Promise.resolve();
  assert.equal(settled, false, "nothing is stopped until the run exists");
  created({ ok: true, runId: "new-run" });
  assert.deepEqual(await target, { kind: "run", runId: "new-run" });

  // A send that failed started nothing: there is nothing to stop and nothing to report.
  assert.deepEqual(await resolveStopTarget(undefined, undefined, Promise.resolve({ ok: false })), { kind: "nothing-started" });
  assert.deepEqual(await resolveStopTarget(undefined, undefined, Promise.reject(new Error("offline"))), { kind: "nothing-started" });
});
