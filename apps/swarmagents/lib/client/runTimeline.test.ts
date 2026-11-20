import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceRunTimeline,
  extractApprovals,
  pendingApprovals,
  slowestTools,
  lifecycleEventLine,
  redactEventData,
  type RunTimeline,
  type ToolCallEntry,
} from "./runTimeline";
import type { RunStreamItem } from "./useRunStream";

function item(kind: string, data: unknown, ts: number, seq: number): RunStreamItem {
  return { seq, kind, data, parsed: { id: String(seq), event: kind, data: "" }, ts };
}

const T0 = 1_000_000;
const T1 = T0 + 250; // tool A call
const T2 = T0 + 1750; // tool A result (1.5s)
const T3 = T0 + 1850; // tool B call
const T4 = T0 + 3350; // tool B result (1.5s) — error
const T5 = T0 + 3350; // run finished

const baseEvents: RunStreamItem[] = [
  item("run.started", { sessionId: "s1", model: "claude-opus" }, T0, 1),
  item("assistant.text", { text: "let me search" }, T0 + 10, 2),
  item("usage", { inputTokens: 500, outputTokens: 30 }, T0 + 10, 3),
  item("tool.call", { id: "toolu_A", name: "Bash", input: { command: "ls" } }, T1, 4),
  item("tool.result", { id: "toolu_A", ok: true, output: "a.txt", truncated: false }, T2, 5),
  item("tool.call", { id: "toolu_B", name: "WebFetch", input: { url: "https://x" } }, T3, 6),
  item("tool.result", { id: "toolu_B", ok: false, output: "403 blocked", truncated: false }, T4, 7),
  item("usage", { inputTokens: 300, outputTokens: 20, cachedTokens: 100 }, T4, 8),
  item("run.finished", { exitCode: 0, costUsd: 0.042, durationMs: 3350, numTurns: 2 }, T5, 9),
];

test("pairs tool calls with results and computes durations / ok", () => {
  const { tools } = reduceRunTimeline(baseEvents);

  assert.equal(tools.length, 2);

  const bash = tools[0];
  assert.equal(bash.name, "Bash");
  assert.equal(bash.status, "done");
  assert.equal(bash.ok, true);
  assert.equal(bash.durationMs, 1500);
  assert.equal(bash.startedAt, T1);
  assert.equal(bash.endedAt, T2);
  assert.deepEqual(bash.input, { command: "ls" });
  assert.equal(bash.output, "a.txt");

  const fetch = tools[1];
  assert.equal(fetch.name, "WebFetch");
  assert.equal(fetch.status, "error");
  assert.equal(fetch.ok, false);
  assert.equal(fetch.durationMs, 1500);
  assert.equal(fetch.output, "403 blocked");
});

test("active tool call carries status running with no duration", () => {
  const running = baseEvents.slice(0, 6); // cut before toolu_B result
  const { tools } = reduceRunTimeline(running);
  const bash = tools[0];
  assert.equal(bash.status, "done");
  const fetch = tools[1];
  assert.equal(fetch.status, "running");
  assert.equal(fetch.ok, undefined);
  assert.equal(fetch.durationMs, undefined);
  assert.equal(fetch.endedAt, undefined);
});

test("sums token usage snapshots and carries run.finished cost", () => {
  const { tools, summary } = reduceRunTimeline(baseEvents);

  assert.equal(summary.startedAt, T0);
  assert.equal(summary.finishedAt, T5);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.model, "claude-opus");
  assert.equal(summary.costUsd, 0.042);
  assert.equal(summary.durationMs, 3350);
  assert.equal(summary.numTurns, 2);
  assert.equal(summary.tokensIn, 800);
  assert.equal(summary.tokensOut, 50);
  assert.equal(summary.tokensCached, 100);
  assert.equal(summary.usageReported, true);
  assert.equal(summary.error, undefined);
  assert.equal(tools.length, 2);
});

test("marks usage as unreported when no usage events arrive", () => {
  const { summary } = reduceRunTimeline([
    item("run.started", {}, T0, 1),
    item("assistant.text", { text: "hi" }, T0 + 10, 2),
    item("run.finished", { exitCode: 0, costUsd: 0.001 }, T5, 3),
  ]);
  assert.equal(summary.usageReported, false);
  assert.equal(summary.tokensIn, 0);
  assert.equal(summary.tokensOut, 0);
});

test("zero-valued usage events still count as reported (legacy proxies)", () => {
  const { summary } = reduceRunTimeline([
    item("usage", { inputTokens: 0, outputTokens: 0 }, T0, 1),
  ]);
  assert.equal(summary.usageReported, true);
  assert.equal(summary.tokensIn, 0);
  assert.equal(summary.tokensOut, 0);
});

test("run.error sets the error and terminates the summary", () => {
  const events = [
    item("run.started", {}, T0, 1),
    item("tool.call", { id: "t1", name: "Bash", input: {} }, T1, 2),
    item("run.error", { exitCode: 1, message: "claude exited with code 1" }, T0 + 500, 3),
  ];
  const { summary, tools } = reduceRunTimeline(events);

  assert.equal(summary.error, "claude exited with code 1");
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.finishedAt, T0 + 500);
  assert.equal(tools[0].status, "running"); // no result: still open
});

test("run.cancelled records the reason", () => {
  const { summary } = reduceRunTimeline([
    item("run.started", {}, T0, 1),
    item("run.cancelled", { reason: "user" }, T0 + 200, 2),
  ]);
  assert.equal(summary.cancelledReason, "user");
  assert.equal(summary.finishedAt, T0 + 200);
});

test("result without a matching call id closes the most recent running call", () => {
  const events = [
    item("tool.call", { id: "t1", name: "Bash", input: {} }, T1, 1),
    item("tool.call", { id: "t2", name: "WebFetch", input: {} }, T3, 2),
    item("tool.result", { id: "nosuch", ok: true, output: "?" }, T4, 3),
  ];
  const { tools } = reduceRunTimeline(events);

  assert.equal(tools.length, 2);
  assert.equal(tools[1].status, "done");
  assert.equal(tools[1].ok, true);
  assert.equal(tools[1].durationMs, T4 - T3);
  // The unmatched call stays open.
  assert.equal(tools[0].status, "running");
});

test("result with no id surfaces as a zero-duration entry when nothing is open", () => {
  const { tools } = reduceRunTimeline([
    item("tool.result", { ok: false, output: "boom" }, T1, 1),
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "error");
  assert.equal(tools[0].ok, false);
  assert.equal(tools[0].durationMs, 0);
});

test("rerunning the reducer on the same items is idempotent", () => {
  const a = reduceRunTimeline(baseEvents);
  const b = reduceRunTimeline(baseEvents);
  assert.deepEqual(a, b);
});

test("replayed tool.call with an existing id refreshes the row instead of duplicating", () => {
  const events = [
    item("tool.call", { id: "t1", name: "Bash", input: { command: "ls" } }, T1, 1),
    item("tool.result", { id: "t1", ok: true, output: "x" }, T2, 2),
    item("tool.call", { id: "t1", name: "Bash", input: { command: "pwd" } }, T3, 3),
  ];
  const { tools } = reduceRunTimeline(events);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "running");
  assert.equal(tools[0].startedAt, T1); // first start is retained
  assert.deepEqual(tools[0].input, { command: "pwd" });
});

test("ignores non-timeline events and raw-string payloads", () => {
  const { tools, summary } = reduceRunTimeline([
    item("message", "raw line", T0, 1),
    item("run.started", {}, T0, 2),
    item("assistant.text", "plain", T0, 3),
  ]);
  assert.equal(tools.length, 0);
  assert.equal(summary.startedAt, T0);
  assert.equal(summary.tokensIn, 0);
});

// ── approvals ──

test("approval.required creates a pending entry with tool, action, reason and risk level", () => {
  const events = [
    item("approval.required", {
      type: "approval.required",
      approval: {
        id: "appr_1",
        tool: "Bash",
        action: "rm -rf /",
        reason: "destructive root deletion requires approval",
        riskLevel: "ask",
      },
    }, T1, 1),
  ];
  const { approvals, tools, summary } = reduceRunTimeline(events);

  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0], {
    id: "appr_1",
    tool: "Bash",
    action: "rm -rf /",
    reason: "destructive root deletion requires approval",
    riskLevel: "ask",
    status: "pending",
    ts: T1,
  });
  assert.equal(pendingApprovals(approvals).length, 1);
  // The approval does not shape the tool timeline.
  assert.equal(tools.length, 0);
  assert.equal(summary.tokensIn, 0);
});

test("approval.resolved marks the entry and it stops being pending", () => {
  const events: RunStreamItem[] = [
    item("approval.required", {
      approval: { id: "appr_1", tool: "Bash", action: "rm -rf /", reason: "ask reason", riskLevel: "ask" },
    }, T1, 1),
  ];

  const denied = reduceRunTimeline([
    ...events,
    item("approval.resolved", { id: "appr_1", verdict: "denied" }, T2, 2),
  ]);
  assert.equal(denied.approvals[0].status, "denied");
  assert.equal(pendingApprovals(denied.approvals).length, 0);

  const approved = reduceRunTimeline([
    ...events,
    item("approval.resolved", { id: "appr_1", verdict: "approved" }, T2, 2),
  ]);
  assert.equal(approved.approvals[0].status, "approved");
  assert.equal(pendingApprovals(approved.approvals).length, 0);

  const expired = reduceRunTimeline([
    ...events,
    item("approval.resolved", { id: "appr_1", verdict: "expired" }, T2, 2),
  ]);
  assert.equal(expired.approvals[0].status, "expired");
});

test("approval.resolved for an unknown or invalid payload is ignored", () => {
  const resolved = reduceRunTimeline([
    item("approval.resolved", { id: "appr_ghost", verdict: "approved" }, T1, 1),
  ]);
  assert.equal(resolved.approvals.length, 0);

  const noId = reduceRunTimeline([
    item("approval.required", { approval: { tool: "Bash", action: "x", reason: "y" } }, T1, 1),
  ]);
  assert.equal(noId.approvals.length, 0);

  const badVerdict = reduceRunTimeline([
    item("approval.required", { approval: { id: "appr_1", tool: "Bash", action: "x", reason: "y", riskLevel: "ask" } }, T1, 1),
    item("approval.resolved", { id: "appr_1", verdict: "maybe" }, T2, 2),
  ]);
  assert.equal(badVerdict.approvals[0].status, "pending");
});

test("multiple approvals resolve independently and replay refreshes in place", () => {
  const events: RunStreamItem[] = [
    item("approval.required", { approval: { id: "appr_1", tool: "Bash", action: "cmd a", reason: "r1", riskLevel: "ask" } }, T1, 1),
    item("approval.required", { approval: { id: "appr_2", tool: "WebFetch", action: "https://x", reason: "r2", riskLevel: "ask" } }, T1, 2),
    item("approval.resolved", { id: "appr_1", verdict: "approved" }, T2, 3),
  ];
  const { approvals } = reduceRunTimeline(events);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].status, "approved");
  assert.equal(approvals[1].status, "pending");
  assert.equal(pendingApprovals(approvals).length, 1);

  // Replay of approval.required keeps one entry per id.
  const replayed = reduceRunTimeline([
    ...events,
    item("approval.required", { approval: { id: "appr_1", tool: "Bash", action: "cmd a", reason: "r1", riskLevel: "ask" } }, T1, 4),
  ]);
  assert.equal(replayed.approvals.length, 2);
});

test("legacy approval.required without riskLevel defaults to ask", () => {
  const { approvals } = reduceRunTimeline([
    item("approval.required", { approval: { id: "appr_1", tool: "Bash", action: "cmd", reason: "r" } }, T1, 1),
  ]);
  assert.equal(approvals[0].riskLevel, "ask");
});

test("extractApprovals matches the reducer's approval list", () => {
  const events: RunStreamItem[] = [
    item("tool.call", { id: "t1", name: "Bash", input: {} }, T1, 1),
    item("approval.required", { approval: { id: "appr_1", tool: "Bash", action: "sudo x", reason: "r", riskLevel: "ask" } }, T1, 2),
    item("approval.resolved", { id: "appr_1", verdict: "approved" }, T2, 3),
  ];
  assert.deepEqual(extractApprovals(events), reduceRunTimeline(events).approvals);
});

test("approval.required carries the auto-deny deadline", () => {
  const { approvals } = reduceRunTimeline([
    item("approval.required", {
      approval: { id: "appr_1", tool: "Bash", action: "x", reason: "r", riskLevel: "ask", expiresAt: T1 + 300_000 },
    }, T1, 1),
  ]);
  assert.equal(approvals[0].expiresAt, T1 + 300_000);
  assert.equal(approvals[0].timedOut, undefined);
});

test("approval.timeout marks the gate expired before approval.resolved arrives", () => {
  const events: RunStreamItem[] = [
    item("approval.required", {
      approval: { id: "appr_1", tool: "Bash", action: "x", reason: "r", riskLevel: "ask", expiresAt: T2 },
    }, T1, 1),
    item("approval.timeout", { id: "appr_1", expiresAt: T2 }, T2, 2),
  ];
  const { approvals } = reduceRunTimeline(events);
  assert.equal(approvals[0].status, "expired");
  assert.equal(approvals[0].timedOut, true);
  assert.equal(pendingApprovals(approvals).length, 0);

  const resolved = reduceRunTimeline([
    ...events,
    item("approval.resolved", { id: "appr_1", verdict: "expired" }, T2, 3),
  ]);
  assert.equal(resolved.approvals[0].status, "expired");
  assert.equal(resolved.approvals[0].timedOut, true);
});

test("slowestTools ranks finished tools by duration, longest first", () => {
  const timeline = reduceRunTimeline([
    item("tool.call", { id: "a", name: "Bash", input: {} }, T1, 1),
    item("tool.result", { id: "a", ok: true, output: "x" }, T1 + 5000, 2),
    item("tool.call", { id: "b", name: "WebFetch", input: {} }, T1, 3),
    item("tool.result", { id: "b", ok: true, output: "y" }, T1 + 1200, 4),
    item("tool.call", { id: "c", name: "Bash", input: {} }, T1, 5),
    item("tool.result", { id: "c", ok: false, output: "boom" }, T1 + 300, 6),
  ]);
  const most = slowestTools(timeline.tools, 2);
  assert.equal(most.length, 2);
  assert.equal(most[0].id, "a");
  assert.equal(most[0].durationMs, 5000);
  assert.equal(most[1].id, "b");
  assert.equal(most[1].durationMs, 1200);
});

test("slowestTools ignores still-running (unduration) tools and respects limit/empty", () => {
  const running = reduceRunTimeline([
    item("tool.call", { id: "a", name: "Bash", input: {} }, T1, 1),
  ]);
  assert.deepEqual(slowestTools(running.tools), []);

  const done = reduceRunTimeline([
    item("tool.call", { id: "a", name: "Bash", input: {} }, T1, 1),
    item("tool.result", { id: "a", ok: true, output: "x" }, T1 + 900, 2),
  ]);
  assert.equal(slowestTools(done.tools, 0).length, 0);
  assert.equal(slowestTools(done.tools, 5).length, 1);
  assert.equal(slowestTools([]).length, 0);
});

test("lifecycleEventLine renders run.queued as a short human line without the userId", () => {
  // The raw event the server emits, including the internal identifiers that
  // used to leak into the terminal as dumped JSON.
  const raw = {
    position: 1,
    prompt: "build it",
    userId: "local_james@swarmagents.codes",
    seq: 7,
    ts: 1_700_000_000_000,
  };
  const line = lifecycleEventLine("run.queued", raw);
  assert.equal(line, "Queued · position 1");
  assert.ok(!line.includes("local_james"), "rendered line must not contain the userId");
  assert.ok(!line.includes("userId"), "rendered line must not mention the userId key");
  assert.ok(!line.includes("build it"), "queued line carries position only, not the prompt");
});

test("lifecycleEventLine renders a bare Queued when no position is present", () => {
  assert.equal(lifecycleEventLine("run.queued", { userId: "local_james@swarmagents.codes" }), "Queued");
  assert.equal(lifecycleEventLine("run.queued", null), "Queued");
  assert.equal(lifecycleEventLine("run.started", { model: "claude" }), null);
  assert.equal(lifecycleEventLine("something.new", { userId: "u1" }), null);
});

test("redactEventData strips userId at every depth and keeps the rest", () => {
  const redacted = redactEventData({
    type: "run.queued",
    position: 2,
    userId: "local_james@swarmagents.codes",
    nested: { userId: "local_james@swarmagents.codes", command: "ls" },
    tags: [{ user_id: "x", keep: "yes" }],
    email: "james@example.com",
  });
  assert.deepEqual(redacted, {
    type: "run.queued",
    position: 2,
    nested: { command: "ls" },
    tags: [{ keep: "yes" }],
  });
  assert.ok(!JSON.stringify(redacted).includes("local_james"));
});

test("reduceRunTimeline ignores run.queued without touching the summary", () => {
  const timeline = reduceRunTimeline([
    item("run.queued", { position: 1, prompt: "second", userId: "alice" }, T0, 1),
    item("run.started", { sessionId: "s1", model: "claude-opus" }, T0 + 10, 2),
  ]);
  assert.deepEqual(timeline.tools, []);
  assert.equal(timeline.summary.model, "claude-opus");
});
