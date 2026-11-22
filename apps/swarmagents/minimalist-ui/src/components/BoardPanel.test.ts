import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOARD_ACTIVE_SINCE } from "../../../lib/client/board";
import type { SwarmTask } from "../../../lib/mcp-types";
import { countOf, installBrowserStubs, makeBoard, makeTask } from "../testing/harness";

const CURRENT = BOARD_ACTIVE_SINCE + 10_000;
const STALE = BOARD_ACTIVE_SINCE - 10_000;

function dated(id: string, title: string, ts: number): SwarmTask {
  return makeTask({ id, title, createdAt: ts, updatedAt: ts });
}

async function renderPanel(tasks: SwarmTask[]) {
  installBrowserStubs({});
  const { BoardPanel } = await import("./BoardPanel");
  return renderToStaticMarkup(
    React.createElement(BoardPanel, {
      board: makeBoard(tasks),
      agentName: "tester",
      runFor: () => undefined,
      onRunTask: async () => undefined,
      onViewRun: () => {},
    }),
  );
}

test("the default Board shows current work and hides the frozen-era tasks", async () => {
  const html = await renderPanel([
    dated("stale1", "Old monolith work", STALE),
    dated("stale2", "Another old task", STALE),
    dated("fresh", "Current work", CURRENT),
  ]);
  assert.equal(countOf(html, 'data-testid="board-task"'), 1, "only the current task is shown");
  assert.match(html, /Current work/);
  assert.doesNotMatch(html, /Old monolith work/);
  assert.doesNotMatch(html, /Another old task/);
  assert.match(html, /Show all tasks \(2 hidden\)/, "the number of hidden tasks is visible");
});

test("the stale toggle shows the hidden count and the way back to active work", async () => {
  installBrowserStubs({});
  const { BoardStaleToggle } = await import("./BoardPanel");
  const hidden = renderToStaticMarkup(
    React.createElement(BoardStaleToggle, { hiddenCount: 3, showAll: false, onToggle() {} }),
  );
  assert.equal(countOf(hidden, 'data-testid="board-show-all-toggle"'), 1);
  assert.match(hidden, /Show all tasks \(3 hidden\)/);
  const shown = renderToStaticMarkup(
    React.createElement(BoardStaleToggle, { hiddenCount: 3, showAll: true, onToggle() {} }),
  );
  assert.match(shown, /Show active work only/);
  const none = renderToStaticMarkup(
    React.createElement(BoardStaleToggle, { hiddenCount: 0, showAll: false, onToggle() {} }),
  );
  assert.equal(none, "", "no toggle when there is nothing hidden");
});

test("dedupe still collapses same-titled current tasks after filtering", async () => {
  const html = await renderPanel([
    dated("a", "[fix] Same task", CURRENT),
    dated("b", "Same task", CURRENT),
    dated("stale", "Old monolith work", STALE),
  ]);
  assert.equal(countOf(html, 'data-testid="board-task"'), 1, "the duplicate pair still reads once");
  assert.equal(countOf(html, 'data-testid="board-task-duplicates"'), 1, "the ×2 count is still shown");
  assert.match(html, /Show all tasks \(1 hidden\)/);
});

test("a board with only current work needs no toggle", async () => {
  const html = await renderPanel([dated("fresh", "Current work", CURRENT)]);
  assert.equal(countOf(html, 'data-testid="board-task"'), 1);
  assert.equal(countOf(html, 'data-testid="board-show-all-toggle"'), 0);
});
