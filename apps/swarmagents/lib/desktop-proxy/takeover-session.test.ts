/**
 * TakeoverSessionManager tests (lib/desktop-proxy/takeover-session.ts).
 *
 * Covers the session glue around the takeover state machine: immediate
 * grant while the agent is paused, grant at a safe point, request-timeout
 * policies (force-grant / deny), single-controller conflicts, handback
 * summaries (window titles + modified files + input counts via a fake VM
 * exec), disconnect handling, and requests queued behind an in-flight
 * handback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  StateTransitionError,
  TakeoverSessionManager,
  type TakeoverExec,
} from "./takeover-session";
import type { InputEvent } from "./takeover/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AuditEntry {
  user: string;
  action: string;
  target: string;
  result: string;
}

/** Fake VM exec: xdotool serves queued titles, find serves the file list. */
function fakeExec(titles: string[], files: string[]): TakeoverExec {
  const queue = [...titles];
  return async (_userId, cmd, opts) => {
    if (cmd[0] === "xdotool") {
      opts?.onStdout?.(queue.shift() ?? "");
      return { exitCode: 0 };
    }
    if (cmd[0] === "find") {
      opts?.onStdout?.(files.map((f) => `/workspace/${f}`).join("\n") + "\n");
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  };
}

function makeManager(overrides: {
  titles?: string[];
  files?: string[];
  requestTimeoutMs?: number;
  timeoutMode?: "grant" | "deny";
} = {}) {
  const audits: AuditEntry[] = [];
  const transitions: string[] = [];
  const manager = new TakeoverSessionManager({
    exec: fakeExec(overrides.titles ?? [], overrides.files ?? []),
    audit: (entry) => audits.push(entry),
    requestTimeoutMs: overrides.requestTimeoutMs ?? 60_000,
    timeoutMode: overrides.timeoutMode,
    windowPollIntervalMs: 5,
    onTransition: (_userId, event) => transitions.push(`${event.from}->${event.to}`),
  });
  return { manager, audits, transitions };
}

const move: InputEvent = { kind: "mouse_move", x: 10, y: 20 };
const click: InputEvent = { kind: "mouse_down", x: 10, y: 20, button: "left" };

test("takeover session: request grants immediately while the agent is paused", () => {
  const { manager, audits, transitions } = makeManager();
  manager.requestTakeover("alice", "client-1");
  const snap = manager.getState("alice");
  assert.equal(snap.state, "HUMAN_DRIVING");
  assert.equal(manager.canAcceptInput("alice", "client-1"), true);
  assert.equal(manager.canAcceptInput("alice", "client-2"), false);
  assert.deepEqual(transitions, [
    "AGENT_DRIVING->HUMAN_REQUESTED",
    "HUMAN_REQUESTED->HUMAN_DRIVING",
  ]);
  assert.deepEqual(
    audits.map((a) => a.action),
    ["desktop.takeover.request", "desktop.takeover"],
  );
  manager.disposeAll();
});

test("takeover session: a live agent defers the grant to the next safe point", () => {
  const { manager } = makeManager();
  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  assert.equal(manager.getState("alice").state, "HUMAN_REQUESTED");
  assert.equal(manager.canAcceptInput("alice", "client-1"), false);

  assert.equal(manager.notifySafePoint("alice"), true);
  assert.equal(manager.getState("alice").state, "HUMAN_DRIVING");
  assert.equal(manager.canAcceptInput("alice", "client-1"), true);
  // A second safe point is a no-op once granted.
  assert.equal(manager.notifySafePoint("alice"), false);
  manager.disposeAll();
});

test("takeover session: pausing the agent grants a pending request", () => {
  const { manager } = makeManager();
  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  assert.equal(manager.getState("alice").state, "HUMAN_REQUESTED");
  manager.setAgentPaused("alice", true);
  assert.equal(manager.getState("alice").state, "HUMAN_DRIVING");
  manager.disposeAll();
});

test("takeover session: request timeout force-grants by default", async () => {
  const { manager } = makeManager({ requestTimeoutMs: 30 });
  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  assert.equal(manager.getState("alice").state, "HUMAN_REQUESTED");
  await sleep(80);
  assert.equal(manager.getState("alice").state, "HUMAN_DRIVING");
  manager.disposeAll();
});

test("takeover session: request timeout can deny instead", async () => {
  const { manager, audits } = makeManager({ requestTimeoutMs: 30, timeoutMode: "deny" });
  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  await sleep(80);
  const snap = manager.getState("alice");
  assert.equal(snap.state, "AGENT_DRIVING");
  assert.equal(snap.controllerId, null);
  assert.equal(manager.canAcceptInput("alice", "client-1"), false);
  assert.ok(
    audits.some((a) => a.action === "desktop.takeover.request" && a.result === "failure"),
    "timeout denial is audited as a failed request",
  );
  manager.disposeAll();
});

test("takeover session: a second controller conflicts while one is active", () => {
  const { manager } = makeManager();
  manager.requestTakeover("alice", "client-1");
  assert.throws(
    () => manager.requestTakeover("alice", "client-2"),
    (err: unknown) => err instanceof StateTransitionError && err.code === "TAKEOVER_ALREADY_ACTIVE",
  );
  // A different user is unaffected.
  manager.requestTakeover("bob", "client-9");
  assert.equal(manager.getState("bob").state, "HUMAN_DRIVING");
  manager.disposeAll();
});

test("takeover session: handback summary carries titles, files, and input counts", async () => {
  const { manager } = makeManager({
    titles: ["Editor — notes.txt", "Editor — notes.txt"],
    files: ["notes.txt", "src/app.ts", ".swarm/state.json"],
  });
  manager.requestTakeover("alice", "client-1");
  await sleep(15); // let the window poller record
  manager.recordInput("alice", "client-1", move);
  manager.recordInput("alice", "client-1", click);
  // Input from a non-controller is never counted.
  manager.recordInput("alice", "client-2", click);

  const summary = await manager.handback("alice", "client-1");
  assert.ok(summary);
  assert.equal(manager.getState("alice").state, "AGENT_DRIVING");
  assert.equal(summary.inputEventsCount, 2);
  assert.deepEqual(summary.windowTitles, ["Editor — notes.txt"]);
  // The .swarm internals are filtered out of the file diff.
  assert.deepEqual(summary.modifiedFiles.sort(), ["notes.txt", "src/app.ts"]);
  assert.equal(manager.getLastSummary("alice"), summary);
  assert.ok(summary.text.includes("notes.txt"));
  manager.disposeAll();
});

test("takeover session: disconnect mid-drive force-handbacks with a summary", async () => {
  const { manager, transitions } = makeManager({ titles: ["Browser — docs"] });
  manager.requestTakeover("alice", "client-1");
  await sleep(15);
  manager.recordInput("alice", "client-1", click);

  const outcome = await manager.handleDisconnect("alice", "client-1");
  assert.equal(outcome, "handback");
  assert.equal(manager.getState("alice").state, "AGENT_DRIVING");
  const summary = manager.getLastSummary("alice");
  assert.ok(summary);
  assert.equal(summary.inputEventsCount, 1);
  assert.ok(transitions.includes("HUMAN_DRIVING->HANDBACK"));
  assert.ok(transitions.includes("HANDBACK->AGENT_DRIVING"));
  manager.disposeAll();
});

test("takeover session: disconnect while requested cancels the request", async () => {
  const { manager } = makeManager();
  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  const outcome = await manager.handleDisconnect("alice", "client-1");
  assert.equal(outcome, "cancelled");
  assert.equal(manager.getState("alice").state, "AGENT_DRIVING");
  assert.equal(manager.getLastSummary("alice"), null);
  // Disconnects from bystanders are no-ops.
  assert.equal(await manager.handleDisconnect("alice", "client-2"), "noop");
  manager.disposeAll();
});

test("takeover session: a request during handback finalize is queued, then granted", async () => {
  // Slow find: the handback stays in HANDBACK long enough to queue behind.
  const slowExec: TakeoverExec = async (_userId, cmd, opts) => {
    if (cmd[0] === "find") {
      await sleep(60);
      opts?.onStdout?.("");
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  };
  const manager = new TakeoverSessionManager({
    exec: slowExec,
    audit: () => {},
    requestTimeoutMs: 60_000,
    windowPollIntervalMs: 5,
  });
  manager.requestTakeover("alice", "client-1");
  const handbackPromise = manager.handback("alice", "client-1");
  assert.equal(manager.getState("alice").state, "HANDBACK");

  // Queued, not refused; a second queued client conflicts.
  manager.requestTakeover("alice", "client-2");
  assert.throws(
    () => manager.requestTakeover("alice", "client-3"),
    (err: unknown) => err instanceof StateTransitionError && err.code === "TAKEOVER_ALREADY_ACTIVE",
  );

  await handbackPromise;
  assert.equal(manager.getState("alice").state, "HUMAN_DRIVING");
  assert.equal(manager.canAcceptInput("alice", "client-2"), true);
  manager.disposeAll();
});

test("takeover session: forceHandback ends a drive and cancels a request", async () => {
  const { manager } = makeManager();
  assert.equal(await manager.forceHandback("alice"), "noop");

  manager.setAgentPaused("alice", false);
  manager.requestTakeover("alice", "client-1");
  assert.equal(await manager.forceHandback("alice"), "cancelled");
  assert.equal(manager.getState("alice").state, "AGENT_DRIVING");

  manager.setAgentPaused("alice", true);
  manager.requestTakeover("alice", "client-1");
  assert.equal(await manager.forceHandback("alice"), "handback");
  assert.equal(manager.getState("alice").state, "AGENT_DRIVING");
  assert.ok(manager.getLastSummary("alice"));
  manager.disposeAll();
});
