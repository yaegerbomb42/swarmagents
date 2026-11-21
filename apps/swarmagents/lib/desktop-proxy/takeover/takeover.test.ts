import test from "node:test";
import assert from "node:assert/strict";
import {
  StateTransitionError,
  TakeoverStateMachine,
} from "./state-machine.js";
import { computeDamageRegions } from "./diff.js";
import { KeyframeStore } from "./keyframe-store.js";
import {
  defaultFrameCaptioner,
  estimateTokens,
  HandbackSummarizer,
  truncateToTokenBudget,
} from "./handback-summarizer.js";
import type { HandbackSummary } from "./types.js";

function fakeSummary(): HandbackSummary {
  return {
    text: "Human drove.",
    tokenCount: 3,
    windowTitles: ["Terminal"],
    modifiedFiles: [],
    lastFrameCaption: "caption",
    durationMs: 1000,
    inputEventsCount: 2,
    generatedAt: Date.now(),
  };
}

test("machine: full happy path with listener events", () => {
  const m = new TakeoverStateMachine();
  const seen: string[] = [];
  const off = m.onTransition((e) => seen.push(`${e.from}->${e.to}`));
  assert.equal(m.state, "AGENT_DRIVING");
  m.requestTakeover("c1");
  assert.equal(m.state, "HUMAN_REQUESTED");
  assert.equal(m.controllerId, "c1");
  assert.equal(m.canAcceptInput("c1"), false);
  m.grantHumanControl();
  assert.equal(m.canAcceptInput("c1"), true);
  assert.equal(m.canAcceptInput("c2"), false);
  m.beginHandback("c1");
  assert.equal(m.state, "HANDBACK");
  m.completeHandback(fakeSummary());
  assert.equal(m.state, "AGENT_DRIVING");
  assert.equal(m.controllerId, null);
  assert.equal(m.lastSummary?.text, "Human drove.");
  assert.deepEqual(seen, [
    "AGENT_DRIVING->HUMAN_REQUESTED",
    "HUMAN_REQUESTED->HUMAN_DRIVING",
    "HUMAN_DRIVING->HANDBACK",
    "HANDBACK->AGENT_DRIVING",
  ]);
  off();
});

test("machine: illegal transitions throw with codes", () => {
  const m = new TakeoverStateMachine();
  assert.throws(() => m.grantHumanControl(), (e: unknown) => {
    assert.ok(e instanceof StateTransitionError);
    assert.equal(e.code, "INVALID_TRANSITION");
    return true;
  });
  assert.throws(() => m.beginHandback("c1"), /not allowed/);
  assert.throws(() => m.completeHandback(fakeSummary()), /not allowed/);
  m.requestTakeover("c1");
  assert.throws(() => m.requestTakeover("c2"), (e: unknown) => {
    assert.ok(e instanceof StateTransitionError);
    assert.equal(e.code, "TAKEOVER_ALREADY_ACTIVE");
    return true;
  });
  m.grantHumanControl();
  assert.throws(() => m.beginHandback("c2"), (e: unknown) => {
    assert.ok(e instanceof StateTransitionError);
    assert.equal(e.code, "NOT_ACTIVE_CONTROLLER");
    return true;
  });
  assert.throws(() => m.cancelTakeoverRequest(), /Cannot cancel takeover/);
});

test("machine: disconnect cancels a request, force-handbacks a drive", () => {
  const m = new TakeoverStateMachine();
  m.requestTakeover("c1");
  assert.equal(m.handleControllerDisconnect("other"), "noop");
  assert.equal(m.handleControllerDisconnect("c1"), "cancelled");
  assert.equal(m.state, "AGENT_DRIVING");
  m.requestTakeover("c1");
  m.grantHumanControl();
  assert.equal(m.handleControllerDisconnect("c1"), "handback_started");
  assert.equal(m.state, "HANDBACK");
});

function rgbaFrame(w: number, h: number, fill: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(fill);
}

test("diff: identical frames unchanged; one tile change yields one region", () => {
  const a = rgbaFrame(64, 64, 10);
  const same = computeDamageRegions(a, rgbaFrame(64, 64, 10), 64, 64);
  assert.equal(same.changed, false);
  assert.equal(same.regions.length, 0);

  const b = rgbaFrame(64, 64, 10);
  // Change one pixel well inside tile (1,0) (x 32..63, y 0..31), on a
  // sampled row/column (the differ samples every 2nd pixel).
  const idx = (4 * 64 + 40) * 4;
  b[idx] = 200;
  const one = computeDamageRegions(a, b, 64, 64);
  assert.equal(one.changed, true);
  assert.deepEqual(one.regions, [{ x: 32, y: 0, width: 32, height: 32 }]);

  // Sub-threshold change is ignored.
  const c = rgbaFrame(64, 64, 10);
  c[idx] = 15; // delta 5 < threshold 10
  assert.equal(computeDamageRegions(a, c, 64, 64).changed, false);

  // No previous frame, or size mismatch: whole frame.
  assert.deepEqual(computeDamageRegions(null, b, 64, 64).regions, [
    { x: 0, y: 0, width: 64, height: 64 },
  ]);
  assert.equal(computeDamageRegions(rgbaFrame(32, 32, 10), b, 64, 64).changedRatio, 1);
});

test("keyframes: min interval, force, retention + maxFrames prune, lookup", () => {
  const store = new KeyframeStore({ retentionMs: 1000, minIntervalMs: 100, maxFrames: 2 });
  const jpeg = new Uint8Array([1, 2, 3]);
  const first = store.maybeStore(jpeg, 800, 600, "idle", 1000);
  assert.ok(first);
  assert.equal(store.maybeStore(jpeg, 800, 600, "idle", 1050), null);
  const second = store.maybeStore(jpeg, 800, 600, "typing", 1200, true);
  assert.ok(second);
  assert.deepEqual([...first.jpeg], [1, 2, 3]);
  jpeg[0] = 99; // mutating the caller's buffer must not corrupt the stored copy
  assert.deepEqual([...first.jpeg], [1, 2, 3]);
  assert.equal(store.getById(first.meta.id)?.meta.activity, "idle");
  assert.equal(store.getLatest()?.meta.id, second.meta.id);
  // Third store trips maxFrames: oldest pruned.
  store.maybeStore(jpeg, 800, 600, "scroll", 1400, true);
  assert.equal(store.listMeta(1400).length, 2);
  assert.equal(store.getById(first.meta.id), undefined);
  // Retention: everything older than cutoff goes.
  assert.equal(store.listMeta(3000).length, 0);
});

test("summarizer: counts inputs/files/windows and caps at 300 tokens", async () => {
  const titles = ["Terminal", "Browser"];
  let i = 0;
  const s = new HandbackSummarizer({
    adapter: { getActiveWindowTitle: async () => titles[Math.min(i++, 1)] ?? "Browser" },
    maxTokens: 300,
    windowPollIntervalMs: 10_000,
  });
  await s.startTracking();
  s.recordInput({ kind: "mouse_move", x: 1, y: 2 });
  s.recordInput({ kind: "key_down", key: "a", code: "KeyA", modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
  s.recordModifiedFile("src/app.ts");
  const summary = await s.finalize(null);
  assert.equal(summary.inputEventsCount, 2);
  assert.deepEqual(summary.modifiedFiles, ["src/app.ts"]);
  assert.ok(summary.windowTitles.length >= 1);
  assert.ok(summary.tokenCount <= 300, `tokenCount ${summary.tokenCount}`);
  assert.match(summary.text, /Human drove/);
  assert.match(summary.lastFrameCaption, /no frame captured/);
});

test("summarizer: long content truncates to budget with ellipsis", async () => {
  const s = new HandbackSummarizer({
    adapter: { getActiveWindowTitle: async () => "Terminal" },
    maxTokens: 20,
    windowPollIntervalMs: 10_000,
  });
  await s.startTracking();
  for (let n = 0; n < 30; n++) s.recordModifiedFile(`very/long/path/file-number-${n}.ts`);
  const summary = await s.finalize(null);
  assert.ok(summary.tokenCount <= 20, `tokenCount ${summary.tokenCount}`);
  assert.ok(summary.text.endsWith("..."));
  assert.equal(summary.modifiedFiles.length, 30, "structured fields are NOT truncated, only text");
});

test("captioner: deterministic theme from luminance", async () => {
  const dark = await defaultFrameCaptioner(
    { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(0) },
    "Terminal",
  );
  assert.match(dark, /dark-themed/);
  const light = await defaultFrameCaptioner(
    { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(255) },
    "Browser",
  );
  assert.match(light, /light-themed/);
  assert.ok(estimateTokens("hello world") > 0);
  const { text } = truncateToTokenBudget("short text", 300);
  assert.equal(text, "short text");
});
