import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleRunButton } from "./RunReportCard";
import { HistoryPanel } from "./HistoryPanel";

(globalThis as { React?: typeof React }).React = React;

test("ScheduleRunButton renders idle, saving, saved, and error states", () => {
  const idle = renderToStaticMarkup(React.createElement(ScheduleRunButton, { state: "idle", onSchedule: () => {} }));
  assert.ok(idle.includes('data-testid="schedule-from-run"'));
  assert.ok(idle.includes("Schedule"));

  const saved = renderToStaticMarkup(React.createElement(ScheduleRunButton, { state: "saved", onSchedule: () => {} }));
  assert.ok(saved.includes("Scheduled (1h)"));
  assert.ok(saved.includes("disabled"));

  const err = renderToStaticMarkup(React.createElement(ScheduleRunButton, { state: "error", onSchedule: () => {} }));
  assert.ok(err.includes("Retry schedule"));
});

test("HistoryPanel renders unread scheduled runs with jump and mark-read actions", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      open: true,
      onClose: () => {},
      threads: [],
      state: "ready",
      currentId: "",
      onSelect: () => {},
      onNewChat: () => {},
      newChatDisabled: false,
      onRetry: () => {},
      unreadCronRuns: [
        { scheduleId: "s1", scheduleName: "Hourly Check", runId: "run_cron_1", ranAt: Date.now() - 60_000, intervalMinutes: 60 },
      ],
      onJumpToCronRun: () => {},
      onMarkCronRunsRead: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="unread-cron-runs"'));
  assert.ok(markup.includes("Hourly Check"));
  assert.ok(markup.includes('data-testid="unread-cron-run-run_cron_1"'));
  assert.ok(markup.includes('data-testid="mark-cron-runs-read"'));
});
