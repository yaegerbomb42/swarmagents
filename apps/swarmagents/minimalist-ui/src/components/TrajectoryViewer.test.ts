import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatTrajectoryTime,
  parseTrajectoryRecord,
  replayDelay,
  replayReducer,
  TrajectoryPlayer,
  type ReplayState,
} from "./TrajectoryViewer";

const eventRow = (seq: number, ts: number, type: string) => JSON.stringify({
  kind: "event",
  event: { seq, runId: "run_replay", ts, type, data: { text: `detail ${seq}` } },
});

function report(finalText: string) {
  return {
    runId: "run_replay",
    userId: "alice",
    status: "finished",
    steps: [],
    artifacts: [{ rel: "src/main.ts" }],
    shots: [],
    meta: { steps: 0, shots: 0, artifacts: 0 },
    finalText,
  };
}

test("trajectory JSONL is replayed in sequence order with its report and truncation marker", () => {
  const record = parseTrajectoryRecord([
    JSON.stringify({ kind: "owner", userId: "alice" }),
    eventRow(2, 2500, "assistant.text"),
    eventRow(1, 1000, "run.started"),
    JSON.stringify({ kind: "truncated", droppedCount: 3, throughSeq: 4 }),
    JSON.stringify({ kind: "report", report: report("done") }),
  ].join("\n"));

  assert.deepEqual(record.events.map((event) => event.seq), [1, 2]);
  assert.equal(record.report?.finalText, "done");
  assert.deepEqual(record.truncated, { droppedCount: 3, throughSeq: 4 });
  assert.equal(formatTrajectoryTime(65_500), "1:05.5");
});

test("play, pause, completion, restart, speed and scrubbing update replay state", () => {
  const total = 3;
  let state: ReplayState = { index: 0, playing: false, speed: 1 };
  state = replayReducer(state, { type: "toggle", total });
  assert.equal(state.playing, true);
  state = replayReducer(state, { type: "toggle", total });
  assert.equal(state.playing, false);
  state = replayReducer(state, { type: "speed", speed: 4 });
  state = replayReducer(state, { type: "seek", index: 2, total });
  assert.deepEqual(state, { index: 2, playing: false, speed: 4 });
  state = replayReducer(state, { type: "toggle", total });
  assert.deepEqual(state, { index: 0, playing: true, speed: 4 });
  state = replayReducer(state, { type: "advance", total });
  state = replayReducer(state, { type: "advance", total });
  assert.deepEqual(state, { index: 2, playing: false, speed: 4 });
  assert.equal(replayDelay(1000, 5000, 2), 2000);
  assert.equal(replayDelay(1000, 5000, 4), 1000);
});

test("player renders playback controls, timing, and the run report", () => {
  const record = parseTrajectoryRecord([
    JSON.stringify({ kind: "owner", userId: "alice" }),
    eventRow(1, 1000, "run.started"),
    JSON.stringify({ kind: "report", report: report("Completed cleanly") }),
  ].join("\n"));
  const html = renderToStaticMarkup(React.createElement(TrajectoryPlayer, { record }));

  assert.match(html, /Play replay/);
  assert.match(html, /aria-label="Playback speed"/);
  assert.match(html, /1x/);
  assert.match(html, /2x/);
  assert.match(html, /4x/);
  assert.match(html, /View changed files/);
  assert.match(html, /src\/main.ts/);
  assert.match(html, /Replay position/);
  assert.match(html, /0:00\.0/);
  assert.match(html, /Completed cleanly/);
});
