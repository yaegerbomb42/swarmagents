/**
 * Component tests for the workspace: the composer, the run and screen status,
 * the conversation, the board, history and settings. Static renders (see
 * testing/harness.ts) plus the pure functions behind each interaction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationEntry } from "../../../lib/client/conversation";
import type { ToolEntry } from "../../../lib/client/turns";
import { countOf, installBrowserStubs, makeBoard, makeEntry, makeSession, makeTask, tagOf } from "../testing/harness";

const h = React.createElement;
const noop = () => {};

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  const [composer, conversation, board, history, settings, screen, brandPill] = await Promise.all([
    import("./Composer"),
    import("./Conversation"),
    import("./BoardPanel"),
    import("./HistoryPanel"),
    import("./SettingsSheet"),
    import("./dashboard/ScreenFrame"),
    import("./brand/StatusPill"),
  ]);
  return { ...composer, ...conversation, ...board, ...history, ...settings, ...screen, ...brandPill };
}

// ---- Flow B: the composer ----

test("Enter sends, Shift+Enter starts a new line, and composing text never sends", async () => {
  const { composerKeyAction } = await load();
  assert.equal(composerKeyAction({ key: "Enter", shiftKey: false }), "send");
  assert.equal(composerKeyAction({ key: "Enter", shiftKey: true }), "newline");
  assert.equal(composerKeyAction({ key: "Enter", shiftKey: false, isComposing: true }), null, "an IME is still composing");
  assert.equal(composerKeyAction({ key: "a", shiftKey: false }), null);
  assert.equal(composerKeyAction({ key: "Escape", shiftKey: false }), null, "Escape never stops a run from the box");
});

test("a message can go out when it has text or a file, and nothing is in flight", async () => {
  const { canSend } = await load();
  assert.equal(canSend({ text: "", attachments: 0, sending: false }), false);
  assert.equal(canSend({ text: "   \n", attachments: 0, sending: false }), false);
  assert.equal(canSend({ text: "Build it", attachments: 0, sending: false }), true);
  assert.equal(canSend({ text: "", attachments: 2, sending: false }), true, "files alone are a message");
  assert.equal(canSend({ text: "Build it", attachments: 0, sending: true }), false, "no double send");
  assert.equal(canSend({ text: "Build it", attachments: 0, sending: false, blocked: true }), false, "signed out");
});

test("sending empties the box at once; a refusal gives the text and files back with the reason", async () => {
  const { sendDraft } = await load();

  function recorder() {
    const log: string[] = [];
    return {
      log,
      io: {
        setText: (text: string) => log.push(`text=${JSON.stringify(text)}`),
        setFiles: (files: string[]) => log.push(`files=${files.length}`),
        setError: (error: string | undefined) => log.push(`error=${error ?? "none"}`),
        setSending: (sending: boolean) => log.push(`sending=${sending}`),
      },
    };
  }

  // Sent: the box is already empty when the request is made, and stays empty.
  const sent = recorder();
  const ok = await sendDraft(
    { text: "Build it", files: ["a.txt"] },
    {
      ...sent.io,
      onSend: async (text, files) => {
        sent.log.push(`send(${text}, ${files.length})`);
        return { ok: true };
      },
    },
  );
  assert.equal(ok, true);
  assert.deepEqual(sent.log, ["sending=true", "error=none", 'text=""', "files=0", "send(Build it, 1)", "sending=false"]);

  // Refused: everything comes back, with the server's reason.
  const refused = recorder();
  const failed = await sendDraft(
    { text: "Build it", files: ["a.txt"] },
    { ...refused.io, onSend: async () => ({ ok: false, error: "Sign in required." }) },
  );
  assert.equal(failed, false);
  assert.deepEqual(refused.log.slice(-4), ["sending=false", 'text="Build it"', "files=1", "error=Sign in required."]);

  // A thrown error is a refusal too: the draft is never lost.
  const threw = recorder();
  const crashed = await sendDraft(
    { text: "Build it", files: [] as string[] },
    {
      ...threw.io,
      onSend: async () => {
        throw new Error("fetch failed");
      },
    },
  );
  assert.equal(crashed, false);
  assert.deepEqual(threw.log.slice(-3), ['text="Build it"', "files=0", "error=fetch failed"]);
});

test("the composer is labelled and offers Send only when there is something to send", async () => {
  const { Composer } = await load();
  const onSend = async () => ({ ok: true as const });

  const empty = renderToStaticMarkup(h(Composer, { value: "", onChange: noop, onSend }));
  assert.match(tagOf(empty, "composer-input"), /aria-label="Message the agent"/);
  assert.match(tagOf(empty, "composer-input"), /placeholder="Message the agent"/);
  assert.match(tagOf(empty, "composer-send"), /disabled=""/);
  assert.match(tagOf(empty, "composer-send"), /aria-label="Send message"/);
  assert.match(tagOf(empty, "attach-button"), /aria-label="Attach files"/);
  assert.match(empty, /Enter to send · Shift\+Enter for a new line/);

  const typed = renderToStaticMarkup(h(Composer, { value: "Build it", onChange: noop, onSend }));
  assert.doesNotMatch(tagOf(typed, "composer-send"), /disabled=""/);
  assert.match(typed, />Build it<\/textarea>/);

  // While a run is active the box still takes a message: it is queued behind the run.
  const busy = renderToStaticMarkup(h(Composer, { value: "And then deploy", onChange: noop, onSend, busy: true }));
  assert.match(tagOf(busy, "composer-send"), /aria-label="Queue message"/);
  assert.doesNotMatch(tagOf(busy, "composer-send"), /disabled=""/);

  const signedOut = renderToStaticMarkup(
    h(Composer, { value: "Build it", onChange: noop, onSend, blockedReason: "Sign in to message the agent" }),
  );
  assert.match(tagOf(signedOut, "composer-input"), /disabled=""/);
  assert.match(tagOf(signedOut, "composer-input"), /placeholder="Sign in to message the agent"/);
  assert.match(tagOf(signedOut, "composer-send"), /disabled=""/);
  assert.match(tagOf(signedOut, "attach-button"), /disabled=""/);
});

// ---- Flow A: run status and the screen ----

test("the screen reports its state in the same dot-and-word vocabulary as a run", async () => {
  const { screenStatus, screenPillStatus, fitStageScale } = await load();
  const desktop = { activeView: "desktop" as const, runActive: true, control: false };

  assert.deepEqual(screenStatus({ ...desktop, phase: "live", latencyMs: 42 }), { label: "Running · 42 ms", tone: "ok", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "live" }), { label: "Running", tone: "ok", live: true });
  // A live stream with no run is just "Live": the desktop is up, waiting.
  assert.deepEqual(screenStatus({ ...desktop, phase: "live", runActive: false, latencyMs: 42 }), { label: "Live · 42 ms", tone: "ok", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "live", runActive: false }), { label: "Live", tone: "ok", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "starting" }), { label: "Starting", tone: "warn", live: true });
  assert.deepEqual(screenStatus({ ...desktop }), { label: "Connecting", tone: "warn", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "reconnecting" }), { label: "Reconnecting", tone: "warn", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "offline" }), { label: "Offline", tone: "err", live: false });
  assert.deepEqual(screenStatus({ ...desktop, phase: "live", control: true }), { label: "You are in control", tone: "accent", live: false });
  // A requested takeover outranks the control flag: the agent still has the wheel.
  assert.deepEqual(screenStatus({ ...desktop, phase: "live", control: true, takeover: "requested" }), { label: "Waiting for safe point", tone: "warn", live: true });
  assert.deepEqual(screenStatus({ ...desktop, phase: "live", control: true, takeover: "control" }), { label: "You are in control", tone: "accent", live: false });
  assert.deepEqual(screenStatus({ activeView: "terminal", runActive: true, control: false }), { label: "Running", tone: "ok", live: true });
  assert.deepEqual(screenStatus({ activeView: "files", runActive: false, control: false }), { label: "Idle", tone: "muted", live: false });

  // The screen status maps onto the brand pill's five tones (spec 3g).
  assert.equal(screenPillStatus({ label: "You are in control", tone: "accent", live: false }), "running");
  assert.equal(screenPillStatus({ label: "Live", tone: "ok", live: true }), "ok");
  assert.equal(screenPillStatus({ label: "Starting", tone: "warn", live: true }), "warn");
  assert.equal(screenPillStatus({ label: "Offline", tone: "err", live: false }), "error");
  assert.equal(screenPillStatus({ label: "Idle", tone: "muted", live: false }), "idle");

  // The stage is the largest 16:10 rectangle in the box it is given.
  assert.equal(fitStageScale({ width: 0, height: 0 }), null);
  assert.equal(fitStageScale({ width: 1280, height: 800 }), 1);
  assert.equal(fitStageScale({ width: 2560, height: 800 }), 1, "height-bound");
  assert.equal(fitStageScale({ width: 640, height: 2000 }), 0.5, "width-bound");
});

test("the screen frame shows its views, its status and the stage; Take over only on the live desktop", async () => {
  const { ScreenFrame } = await load();
  const base = {
    onToggleView: noop,
    logs: [],
    runActive: false,
    vmState: "ready" as const,
    vmResetting: false,
    activeRoleName: "Agent",
    onResetVm: noop,
    onStopRun: noop,
    control: false,
    onControlChange: noop,
    canControl: true,
  };

  const terminal = renderToStaticMarkup(
    h(ScreenFrame, { ...base, activeView: "terminal", showDesktop: false, desktopMode: false, runActive: true }),
  );
  for (const id of ["screen-frame", "screen-toolbar", "screen-stage", "screen-status-pill", "screen-fullscreen"]) {
    assert.equal(countOf(terminal, `data-testid="${id}"`), 1, id);
  }
  assert.match(tagOf(terminal, "screen-status-pill"), /data-status="ok"/, "brand pill carries the mapped tone");
  assert.equal(countOf(terminal, 'data-testid="screen-view-desktop"'), 0, "no desktop tab when the VM has no desktop");
  for (const view of ["terminal", "browser", "files"]) {
    assert.equal(countOf(terminal, `data-testid="screen-view-${view}"`), 1, view);
  }
  assert.match(tagOf(terminal, "screen-view-terminal"), /aria-selected="true"/);
  assert.match(terminal, /aria-label="Computer views"/);
  assert.match(terminal, />Running</);
  assert.equal(countOf(terminal, 'data-testid="take-over"'), 0);
  assert.match(tagOf(terminal, "screen-fullscreen"), /aria-label="Full screen"/);

  const desktop = renderToStaticMarkup(h(ScreenFrame, { ...base, activeView: "desktop", showDesktop: true, desktopMode: true }));
  assert.equal(countOf(desktop, 'data-testid="screen-view-desktop"'), 1);
  assert.match(tagOf(desktop, "take-over"), /aria-pressed="false"/);
  assert.match(desktop, /Take over/);
  assert.equal(countOf(desktop, 'data-testid="takeover-banner"'), 0);

  for (const activeView of ["desktop", "terminal", "browser", "files"] as const) {
    const html = renderToStaticMarkup(h(ScreenFrame, { ...base, activeView, showDesktop: true, desktopMode: true }));
    assert.equal(countOf(html, 'data-testid="desktop-view"'), 1, `desktop remains mounted in ${activeView}`);
    for (const view of ["desktop", "terminal", "browser", "files"]) {
      assert.equal(countOf(html, `data-testid="screen-view-${view}"`), 1);
    }
  }

  const notReady = renderToStaticMarkup(
    h(ScreenFrame, { ...base, activeView: "desktop", showDesktop: true, desktopMode: true, canControl: false }),
  );
  assert.match(tagOf(notReady, "take-over"), /disabled=""/);

  const driving = renderToStaticMarkup(
    h(ScreenFrame, { ...base, activeView: "desktop", showDesktop: true, desktopMode: true, control: true, runActive: true }),
  );
  assert.match(tagOf(driving, "screen-frame"), /data-control="true"/);
  assert.match(tagOf(driving, "take-over"), /aria-pressed="true"/);
  assert.match(tagOf(driving, "screen-status-pill"), /data-status="running"/, "holding the controls reads as Signal running");
  assert.match(driving, /Hand back/);
  assert.equal(countOf(driving, 'data-testid="takeover-banner"'), 1);
  assert.match(driving, /You are in control/);
  assert.match(driving, /The agent is still working/);
});

test("the brand status pill pulses only when live, and never re-cases its label", async () => {
  const { StatusPill } = await load();
  const live = renderToStaticMarkup(h(StatusPill, { status: "ok", live: true, children: "Live · 42 ms" }));
  assert.match(live, /brand-live-dot/, "a live ok still breathes");
  assert.match(live, /Live · 42 ms/, "the latency label renders verbatim");
  const steady = renderToStaticMarkup(h(StatusPill, { status: "running", live: false, children: "You are in control" }));
  assert.doesNotMatch(steady, /brand-live-dot/, "a steady running pill does not breathe");
  assert.match(steady, /You are in control/);
  const running = renderToStaticMarkup(h(StatusPill, { status: "running", live: true, children: "Running" }));
  assert.match(running, /brand-live-dot/);
});

// ---- Flow B: the conversation ----

test("an empty conversation says what to do next", async () => {
  const { Conversation } = await load();
  const props = { taskLinks: {}, onWatchScreen: noop, onOpenTask: noop, onOpenProviders: noop };

  const empty = renderToStaticMarkup(h(Conversation, { ...props, session: makeSession() }));
  assert.equal(countOf(empty, 'data-testid="conversation-empty"'), 1);
  assert.match(empty, /Tell the agent what you want done/);

  const loading = renderToStaticMarkup(h(Conversation, { ...props, session: makeSession({ turnsLoading: true }) }));
  assert.equal(countOf(loading, 'data-testid="conversation-empty"'), 0);
  assert.match(loading, /Loading conversation/);
});

test("each run is one turn: the message, the reply, its status, and its report", async () => {
  const { Conversation } = await load();
  const finished = makeEntry({
    runId: "run_done",
    prompt: "Fix the login redirect",
    finalText: "The redirect now goes to the **dashboard**.",
    status: "finished",
    sessionId: "sess_1",
    finishedAt: 1_700_000_000_000 + 64_000,
  });
  const failed = makeEntry({
    runId: "run_failed",
    prompt: "Deploy it",
    status: "error",
    error: "The deploy script exited with code 1.",
    sessionId: "sess_1",
    createdAt: 1_700_000_100_000,
    finishedAt: 1_700_000_105_000,
  });
  const html = renderToStaticMarkup(
    h(Conversation, {
      session: makeSession({ turns: [finished, failed], threadKey: "sess_1" }),
      taskLinks: {},
      onWatchScreen: noop,
      onOpenTask: noop,
      onOpenProviders: noop,
    }),
  );

  assert.equal(countOf(html, 'data-testid="turn"'), 2);
  assert.match(html, /data-run-id="run_done"[^>]*data-phase="finished"/);
  assert.match(html, /data-run-id="run_failed"[^>]*data-phase="error"/);
  assert.equal(countOf(html, 'data-testid="conversation-user"'), 2);
  assert.match(html, /Fix the login redirect/);
  assert.match(html, /<strong>dashboard<\/strong>/, "the reply is rendered as markdown");
  assert.match(html, />Finished</);
  assert.match(html, /1m 04s/, "a finished run says how long it took");
  assert.match(html, />Failed</);
  assert.equal(countOf(html, 'data-testid="run-failure"'), 1, "the failure is explained once, on its turn");
  assert.match(html, /The deploy script exited with code 1\./);
  assert.equal(countOf(html, 'data-testid="run-report"'), 2, "every ended run links to its report");
  assert.equal(countOf(html, 'data-testid="toggle-steps"'), 2, "past runs can show their steps");
  assert.equal(countOf(html, 'data-testid="watch-screen"'), 0, "nothing is running");
});

test("the live turn shows what the agent is doing, with a way to its screen", async () => {
  const { Conversation } = await load();
  const running = makeEntry({ runId: "run_live", prompt: "Build a thing", status: "running", createdAt: Date.now() - 4000 });
  const liveEntries: ConversationEntry[] = [
    { kind: "user", key: "u", ts: 1, text: "Build a thing", attachments: [] },
    { kind: "agent", key: "a1", ts: 2, text: "Starting with the tests." },
    { kind: "tool", key: "t1", ts: 3, id: "c1", name: "Bash", label: "Running npm test", status: "running", input: { command: "npm test" } },
  ];
  const html = renderToStaticMarkup(
    h(Conversation, {
      session: makeSession({
        turns: [running],
        activeRun: running,
        headRun: running,
        activeInView: true,
        liveRunId: "run_live",
        liveEntries,
        phase: "running",
        busy: true,
        activity: "Running npm test",
      }),
      taskLinks: {},
      onWatchScreen: noop,
      onOpenTask: noop,
      onOpenProviders: noop,
    }),
  );

  assert.match(html, /data-run-id="run_live"[^>]*data-phase="running"/);
  assert.equal(countOf(html, 'data-testid="conversation-user"'), 1, "the prompt is shown once, not again from the stream");
  assert.match(html, /Starting with the tests\./);
  assert.equal(countOf(html, 'data-testid="steps-block"'), 1);
  assert.match(html, /Running npm test/);
  assert.match(html, />Running</);
  assert.equal(countOf(html, 'data-testid="watch-screen"'), 1, "jump to this run's screen");
  assert.match(html, />Watch computer</, "the button reads 'Watch computer'");
  assert.doesNotMatch(html, /Watch screen/, "no 'Watch screen' label remains");
  assert.equal(countOf(html, 'data-testid="run-report"'), 0, "no report until the run ends");
});

test("a step row shows its label once, with no doubled verb and no 0 ms duration", async () => {
  const { StepRow } = await load();
  const write: ToolEntry = {
    kind: "tool",
    key: "tool:t1",
    ts: 1_000,
    name: "Write",
    label: "Writing /workspace/hello.txt",
    status: "done",
    input: { file_path: "/workspace/hello.txt" },
    durationMs: 0,
  };
  const html = renderToStaticMarkup(h(StepRow, { step: write }));
  assert.match(html, /Writing \/workspace\/hello\.txt/);
  assert.equal(countOf(html, "Write Writing"), 0, "the verb is not doubled");
  assert.equal(countOf(html, "0 ms"), 0, "a 0 ms duration is not shown");

  // A real duration is still shown.
  const slow = renderToStaticMarkup(h(StepRow, { step: { ...write, durationMs: 500 } }));
  assert.match(slow, /500 ms/);

  // A running step shows the spinner and no duration.
  const running = renderToStaticMarkup(h(StepRow, { step: { ...write, status: "running", durationMs: 500 } }));
  assert.match(running, /aria-label="Running"/);
  assert.equal(countOf(running, "500 ms"), 0);
});

test("a steps block opens immediately when defaultOpen is set, so 'Show steps' reveals the list", async () => {
  const { StepsBlock } = await load();
  const write: ToolEntry = {
    kind: "tool",
    key: "tool:t1",
    ts: 1_000,
    name: "Write",
    label: "Writing /workspace/hello.txt",
    status: "done",
    input: { file_path: "/workspace/hello.txt" },
    durationMs: 500,
  };
  const html = renderToStaticMarkup(h(StepsBlock, { steps: [write], defaultOpen: true }));
  assert.match(html, /aria-expanded="true"/, "the step block is expanded");
  assert.equal(countOf(html, 'data-testid="tool-entry"'), 1, "the step list is revealed immediately");
});

test("a steps block stays folded without defaultOpen, keeping the live-run chip as it is", async () => {
  const { StepsBlock } = await load();
  const write: ToolEntry = {
    kind: "tool",
    key: "tool:t1",
    ts: 1_000,
    name: "Write",
    label: "Writing /workspace/hello.txt",
    status: "done",
    input: { file_path: "/workspace/hello.txt" },
    durationMs: 500,
  };
  const html = renderToStaticMarkup(h(StepsBlock, { steps: [write] }));
  assert.match(html, /aria-expanded="false"/);
  assert.equal(countOf(html, 'data-testid="tool-entry"'), 0, "step detail is hidden until the chip is clicked");
});

test("the way to the screen is left out while the screen is already on show", async () => {
  const { Conversation } = await load();
  const running = makeEntry({ runId: "run_live", prompt: "Build a thing", status: "running", createdAt: Date.now() - 4000 });
  const html = renderToStaticMarkup(
    h(Conversation, {
      session: makeSession({ turns: [running], activeRun: running, headRun: running, liveRunId: "run_live", phase: "running", busy: true }),
      taskLinks: {},
      onOpenTask: noop,
      onOpenProviders: noop,
    }),
  );
  assert.equal(countOf(html, 'data-testid="watch-screen"'), 0);
});

test("a question is answered in place while the run waits, and is only a record once the run has ended", async () => {
  const { Conversation } = await load();
  const { closeOpenPrompts } = await import("../../../lib/client/turns");
  const asked: ConversationEntry[] = [
    { kind: "agent", key: "a1", ts: 2, text: "One decision before I start." },
    { kind: "question", key: "question:q1", ts: 3, id: "q1", question: "Which engine should the game use?", options: ["Godot", "Three.js"], allowFreeText: true, status: "pending" },
  ];
  const props = { taskLinks: {}, onWatchScreen: noop, onOpenTask: noop, onOpenProviders: noop };

  const waiting = makeEntry({ runId: "run_q", prompt: "Build a game", status: "running", createdAt: Date.now() - 2000 });
  const open = renderToStaticMarkup(
    h(Conversation, {
      ...props,
      session: makeSession({ turns: [waiting], activeRun: waiting, headRun: waiting, liveRunId: "run_q", liveEntries: asked, phase: "question", busy: true }),
    }),
  );
  assert.match(open, /data-run-id="run_q"[^>]*data-phase="question"/);
  assert.match(open, /The agent needs your answer to continue/);
  assert.equal(countOf(open, 'data-testid="question-option"'), 2);
  assert.equal(countOf(open, 'data-testid="question-answer"'), 1);
  assert.match(open, />Needs your answer</);

  // Stopped before it was answered: the session closes what the run left open.
  const stopped = makeEntry({ runId: "run_q", prompt: "Build a game", status: "cancelled", finishedAt: Date.now() });
  const closed = renderToStaticMarkup(
    h(Conversation, {
      ...props,
      session: makeSession({ turns: [stopped], headRun: stopped, liveRunId: "run_q", liveEntries: closeOpenPrompts(asked), phase: "cancelled" }),
    }),
  );
  assert.match(closed, /Which engine should the game use\?/, "the question stays on the record");
  assert.match(closed, /The run ended before an answer\./);
  assert.equal(countOf(closed, 'data-testid="question-option"'), 0, "nothing left to answer");
  assert.equal(countOf(closed, 'data-testid="question-answer"'), 0);
});

test("the report row states the run's facts, leaving out what is not known", async () => {
  await load();
  const { reportFacts, formatReportDuration } = await import("./RunReportCard");
  const meta = { status: "finished" as const, shots: 0, providers: [] };
  assert.deepEqual(reportFacts({ ...meta, steps: 5, durationMs: 64_000, artifacts: 2, costUsd: 0.0123 }), ["5 steps", "1m 4s", "2 files changed", "$0.012"]);
  assert.deepEqual(reportFacts({ ...meta, steps: 1, artifacts: 1 }), ["1 step", "1 file changed"], "no dash where the duration is unknown");
  assert.equal(formatReportDuration(900), "1s");
});

test("a message shows the moment it is sent, and a queued run can be cancelled where it stands", async () => {
  const { Conversation } = await load();
  const props = { taskLinks: {}, onWatchScreen: noop, onOpenTask: noop, onOpenProviders: noop };

  const pending = renderToStaticMarkup(
    h(Conversation, {
      ...props,
      session: makeSession({ pending: { id: "p1", text: "Build a thing", attachments: [], ts: Date.now() }, phase: "starting", busy: true }),
    }),
  );
  assert.equal(countOf(pending, 'data-testid="turn-pending"'), 1);
  assert.match(pending, /Build a thing/);
  assert.match(pending, /Starting/);
  assert.equal(countOf(pending, 'data-testid="conversation-empty"'), 0);

  const queued = makeEntry({ runId: "run_q", prompt: "And then deploy", status: "queued", createdAt: Date.now() });
  const html = renderToStaticMarkup(h(Conversation, { ...props, session: makeSession({ turns: [queued] }) }));
  assert.match(html, /data-run-id="run_q"[^>]*data-phase="queued"/);
  assert.match(html, />Queued</);
  assert.match(html, />Cancel</);
  assert.equal(countOf(html, 'data-testid="watch-screen"'), 0, "a queued run has no screen yet");
});

test("a run started from a board task points back to the task", async () => {
  const { Conversation } = await load();
  const entry = makeEntry({ runId: "run_task", prompt: "Work on this SwarmBoard task (task_9)…", finalText: "Done.", status: "finished" });
  const html = renderToStaticMarkup(
    h(Conversation, {
      session: makeSession({
        turns: [entry],
        promptFor: () => ({ text: "Fix the login redirect", attachments: [] }),
      }),
      taskLinks: { task_9: { taskId: "task_9", title: "Fix the login redirect", runId: "run_task", agentName: "alice (VM)", startedAt: 1 } },
      onWatchScreen: noop,
      onOpenTask: noop,
      onOpenProviders: noop,
    }),
  );
  assert.match(html, /Fix the login redirect/);
  assert.doesNotMatch(html, /Work on this SwarmBoard task/, "the task's title stands in for the generated prompt");
  assert.match(html, /Open task/);
});

// ---- Flow C: the board ----

// The board's default view shows only current work, so these fixtures are
// dated after the repo move rather than using makeTask's historical default.
const CURRENT_TASK_AT = Date.UTC(2026, 10, 21);
const nowTask = (overrides: Parameters<typeof makeTask>[0] = {}) =>
  makeTask({ createdAt: CURRENT_TASK_AT, updatedAt: CURRENT_TASK_AT, ...overrides });

test("the board lists each task with its status and its pull request, without worker names or bracket tags", async () => {
  const { BoardPanel } = await load();
  const tasks = [
    nowTask({ id: "t_open", title: "Add dark mode", status: "open" }),
    nowTask({ id: "t_claimed", title: "[p2] Fix the login redirect", status: "claimed", claimedBy: "alice@example.com (VM)" }),
    nowTask({
      id: "t_review",
      title: "Write the changelog",
      status: "in_review",
      claimedBy: "bob (VM)",
      gitBranch: "docs/changelog",
      prUrl: "https://github.com/acme/app/pull/128",
      resultSummary: "Changelog covers 2.0.",
    }),
    nowTask({ id: "t_done", title: "Upgrade Node", status: "completed", claimedBy: "carol (VM)" }),
  ];
  const html = renderToStaticMarkup(
    h(BoardPanel, {
      board: makeBoard(tasks),
      agentName: "alice@example.com (VM)",
      runFor: () => undefined,
      onRunTask: async () => undefined,
      onViewRun: noop,
    }),
  );

  for (const status of ["open", "claimed", "in_review", "completed"]) {
    assert.equal(countOf(html, `data-testid="board-group-${status}"`), 1, status);
  }
  assert.equal(countOf(html, 'data-testid="board-task"'), 3, "completed tasks are folded away until asked for");
  for (const title of ["Add dark mode", "Fix the login redirect", "Write the changelog"]) assert.ok(html.includes(title), title);
  assert.match(html, /data-task-id="t_claimed"[^>]*data-status="claimed"/);
  assert.match(html, />In progress</);
  assert.match(html, />In review</);
  assert.doesNotMatch(html, /alice@example\.com \(VM\)/, "worker names stay off the rows");
  assert.doesNotMatch(html, /bob \(VM\)/, "worker names stay off the rows");
  assert.doesNotMatch(html, /\[p2\]/, "bracket tags stay off the rows");
  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/pull\/128"/);
  assert.match(html, /PR #128/);
  assert.match(html, /target="_blank" rel="noreferrer noopener"/);
  // Open tasks can be run; my claimed task can be run again; someone else's cannot.
  assert.equal(countOf(html, 'data-testid="board-run"'), 2);
  assert.equal(countOf(html, 'data-testid="board-add-input"'), 1, "adding a task is always in reach");
});

test("the board shows a duplicated title once, with its count", async () => {
  const { BoardPanel } = await load();
  const html = renderToStaticMarkup(
    h(BoardPanel, {
      board: makeBoard([
        nowTask({ id: "d1", title: "[Router] Automatic per-step model routing", status: "open", updatedAt: CURRENT_TASK_AT }),
        nowTask({ id: "d2", title: "automatic per-step model routing", status: "open", updatedAt: CURRENT_TASK_AT + 1 }),
      ]),
      agentName: "alice (VM)",
      runFor: () => undefined,
      onRunTask: async () => undefined,
      onViewRun: noop,
    }),
  );
  assert.equal(countOf(html, 'data-testid="board-task"'), 1, "the same title reads once");
  assert.equal(countOf(html, 'data-testid="board-task-duplicates"'), 1);
  assert.match(html, /×2/);
  assert.doesNotMatch(html, /\[Router\]/);
});

test("a link that is not http(s) is never rendered as a link", async () => {
  const { BoardPanel } = await load();
  const html = renderToStaticMarkup(
    h(BoardPanel, {
      board: makeBoard([nowTask({ id: "t", status: "in_review", claimedBy: "x", prUrl: "javascript:alert(1)" })]),
      agentName: "alice (VM)",
      runFor: () => undefined,
      onRunTask: async () => undefined,
      onViewRun: noop,
      focusTaskId: "t",
    }),
  );
  assert.doesNotMatch(html, /href="javascript:/);
});

test("an opened task shows its details and result; my claimed task can be submitted for review", async () => {
  const { BoardPanel } = await load();
  const mine = nowTask({
    id: "t_mine",
    title: "Fix the login redirect",
    description: "Fix the login redirect\nUsers land on a blank page.",
    status: "claimed",
    claimedBy: "alice (VM)",
    constraints: ["No new dependencies"],
  });
  const run = makeEntry({
    runId: "run_7",
    status: "finished",
    finalText: "Fixed.\n\nBranch: fix/login-redirect\nPR: https://github.com/acme/app/pull/128",
  });
  const html = renderToStaticMarkup(
    h(BoardPanel, {
      board: makeBoard([mine], {
        links: { t_mine: { taskId: "t_mine", title: mine.title, runId: "run_7", agentName: "alice (VM)", startedAt: 1 } },
      }),
      agentName: "alice (VM)",
      runFor: (runId: string) => (runId === "run_7" ? run : undefined),
      onRunTask: async () => undefined,
      onViewRun: noop,
      focusTaskId: "t_mine",
    }),
  );

  assert.equal(countOf(html, 'data-testid="board-task-detail"'), 1, "the focused task is open");
  assert.match(html, /Users land on a blank page\./);
  assert.match(html, /No new dependencies/);
  assert.equal(countOf(html, 'data-testid="board-view-run"'), 1, "the row links to the run that worked on it");
  assert.match(html, />Finished</);
  assert.equal(countOf(html, 'data-testid="board-submit"'), 1);
  assert.match(html, /value="fix\/login-redirect"/, "the branch is read from the agent's reply");
  assert.match(html, /value="https:\/\/github\.com\/acme\/app\/pull\/128"/);
  assert.match(html, /Run again/);
});

test("the board handles loading, empty, failed and read-only states", async () => {
  const { BoardPanel } = await load();
  const props = { agentName: "alice (VM)", runFor: () => undefined, onRunTask: async () => undefined, onViewRun: noop };

  const loading = renderToStaticMarkup(h(BoardPanel, { ...props, board: makeBoard([], { status: "loading" }) }));
  assert.match(loading, /Loading the board/);
  assert.equal(countOf(loading, 'data-testid="board-empty"'), 0);

  const empty = renderToStaticMarkup(h(BoardPanel, { ...props, board: makeBoard([]) }));
  assert.equal(countOf(empty, 'data-testid="board-empty"'), 1);
  assert.match(empty, /no open tasks in the current filter/);

  const failed = renderToStaticMarkup(
    h(BoardPanel, { ...props, board: makeBoard([], { status: "error", error: { message: "Network error", retryable: true } }) }),
  );
  assert.equal(countOf(failed, 'data-testid="board-error"'), 1);
  assert.match(failed, /The board could not be loaded/);
  assert.match(failed, />Retry</);
  assert.equal(countOf(failed, 'data-testid="board-empty"'), 0, "a failed load is not an empty board");

  const stale = renderToStaticMarkup(
    h(BoardPanel, {
      ...props,
      board: makeBoard([nowTask()], { error: { message: "Network error", retryable: true } }),
    }),
  );
  assert.match(stale, /The board could not be refreshed/);
  assert.match(stale, /Showing the last tasks that loaded/);
  assert.equal(countOf(stale, 'data-testid="board-task"'), 1);

  const readOnly = renderToStaticMarkup(h(BoardPanel, { ...props, board: makeBoard([], { writable: false }) }));
  assert.equal(countOf(readOnly, 'data-testid="board-readonly"'), 1);
  assert.equal(countOf(readOnly, 'data-testid="board-add-readonly-hint"'), 1, "the disabled Add button says why");
  assert.match(readOnly, /Task creation is disabled/);
  const addButton = readOnly.match(/<button[^>]*data-testid="board-add-submit"[^>]*>/);
  assert.ok(addButton, "the Add task button renders");
  assert.match(addButton[0], /disabled/, "the Add task button is disabled while the board is read-only");
});

// ---- History and settings ----

test("history lists conversations, marks the one that is running, and handles empty and failed loads", async () => {
  const { HistoryPanel } = await load();
  const base = {
    open: true,
    onClose: noop,
    currentId: "sess_1",
    onSelect: noop,
    onNewChat: noop,
    newChatDisabled: false,
    onRetry: noop,
  };
  const threads = [
    { id: "sess_1", title: "Fix the login redirect", createdAt: 1, updatedAt: Date.now() - 60_000, runCount: 3 },
    { id: "sess_2", title: "Write the changelog", createdAt: 1, updatedAt: Date.now() - 3_600_000, runCount: 1 },
  ];

  const list = renderToStaticMarkup(h(HistoryPanel, { ...base, threads, state: "ready", activeId: "sess_2" }));
  assert.match(list, /role="dialog" aria-modal="true" aria-label="Conversations"/);
  assert.equal(countOf(list, 'data-testid="history-thread"'), 2);
  assert.match(list, /Fix the login redirect/);
  assert.match(list, /aria-current="true"/, "the open conversation is marked");
  assert.match(list, />Running</, "the conversation with a live run says so");
  assert.equal(countOf(list, 'data-testid="history-new-chat"'), 1);

  const empty = renderToStaticMarkup(h(HistoryPanel, { ...base, threads: [], state: "ready" }));
  assert.equal(countOf(empty, 'data-testid="history-empty"'), 1);

  const failed = renderToStaticMarkup(h(HistoryPanel, { ...base, threads: [], state: "error" }));
  assert.match(failed, />Retry</);
  assert.equal(countOf(failed, 'data-testid="history-empty"'), 0);

  assert.equal(renderToStaticMarkup(h(HistoryPanel, { ...base, open: false, threads, state: "ready" })), "");
});

test("settings open on providers, with the agent's run settings one tab away", async () => {
  const { SettingsSheet } = await load();
  const props = {
    open: true,
    onClose: noop,
    providers: [],
    setProviders: noop,
    serverProviderCount: 0,
    fullAuto: true,
    onFullAutoChange: noop,
    agentCard: "Be brief.",
    onAgentCardChange: noop,
    compute: {
      loaded: true,
      computers: [],
      cloud: { capacity: 1, inUse: 0, full: false },
      freeTier: false,
      defaultTarget: "cloud",
      target: "cloud",
      setTarget: noop,
      byocDefault: false,
    },
    busy: false,
    onResetVm: async () => undefined,
  };

  const providers = renderToStaticMarkup(h(SettingsSheet, { ...props, initialTab: "providers" as const }));
  assert.match(providers, /role="dialog" aria-modal="true" aria-label="Settings"/);
  for (const tab of ["providers", "agent", "computers", "memory", "account"]) {
    assert.equal(countOf(providers, `data-testid="settings-tab-${tab}"`), 1, tab);
  }
  assert.equal(countOf(providers, 'data-testid="settings-tab-general"'), 0);
  assert.equal(countOf(providers, 'data-testid="settings-tab-appearance"'), 0);
  assert.match(tagOf(providers, "settings-tab-providers"), /aria-selected="true"/);

  const agent = renderToStaticMarkup(h(SettingsSheet, { ...props, initialTab: "agent" as const }));
  assert.match(tagOf(agent, "settings-tab-agent"), /aria-selected="true"/);
  for (const id of ["agent-settings", "approvals-auto", "approvals-ask", "agent-instructions", "reset-vm"]) {
    assert.equal(countOf(agent, `data-testid="${id}"`), 1, id);
  }
  assert.match(agent, />Be brief\.<\/textarea>/);
  assert.match(tagOf(agent, "approvals-auto"), /role="radio" aria-checked="true"/);
  assert.match(tagOf(agent, "approvals-ask"), /aria-checked="false"/);

  const asking = renderToStaticMarkup(h(SettingsSheet, { ...props, initialTab: "agent" as const, fullAuto: false, busy: true }));
  assert.match(tagOf(asking, "approvals-ask"), /aria-checked="true"/);
  assert.match(tagOf(asking, "reset-vm"), /disabled=""/, "the VM cannot be reset under a running agent");

  assert.equal(renderToStaticMarkup(h(SettingsSheet, { ...props, open: false, initialTab: "agent" as const })), "");
});

test("settings carries shortcuts, connectors and (in dev mode) the board in its footer", async () => {
  const { SettingsSheet } = await load();
  const props = {
    open: true,
    onClose: noop,
    providers: [],
    setProviders: noop,
    serverProviderCount: 0,
    fullAuto: true,
    onFullAutoChange: noop,
    agentCard: "Be brief.",
    onAgentCardChange: noop,
    compute: {
      loaded: true,
      computers: [],
      cloud: { capacity: 1, inUse: 0, full: false },
      freeTier: false,
      defaultTarget: "cloud",
      target: "cloud",
      setTarget: noop,
      byocDefault: false,
    },
    busy: false,
    onResetVm: async () => undefined,
    onOpenBoard: noop,
    onOpenShortcuts: noop,
  };

  const plain = renderToStaticMarkup(h(SettingsSheet, { ...props, initialTab: "providers" as const }));
  assert.equal(countOf(plain, 'data-testid="settings-more"'), 1);
  assert.equal(countOf(plain, 'data-testid="settings-shortcuts"'), 1);
  assert.equal(countOf(plain, 'data-testid="settings-connectors"'), 1);
  assert.match(plain, /href="\/connectors"/, "connectors links out to the catalog");
  assert.equal(countOf(plain, 'data-testid="settings-board"'), 0, "no board row without dev mode");

  const dev = renderToStaticMarkup(
    h(SettingsSheet, { ...props, initialTab: "providers" as const, devMode: true, boardOpenCount: 3 }),
  );
  assert.equal(countOf(dev, 'data-testid="settings-board"'), 1, "the board row appears in dev mode");
  assert.match(dev, /3 open/, "the board row counts open tasks");
});
