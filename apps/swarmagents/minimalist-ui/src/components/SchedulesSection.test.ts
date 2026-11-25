/**
 * Component tests for the Schedules section: static renders (see
 * testing/harness.ts). Effects never run under renderToStaticMarkup, so the
 * container test asserts the loading state + create form, and the list test
 * drives the pure SchedulesList with sample schedules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import {
  formatInterval,
  formatNextRun,
  type ScheduleView,
} from "./SchedulesSection";

const h = React.createElement;
const T0 = 1_780_000_000_000;

async function load() {
  installBrowserStubs();
  return import("./SchedulesSection");
}

function schedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sch_00000000-0000-0000-0000-000000000001",
    name: "Morning brief",
    prompt: "Summarize what changed overnight.",
    intervalMinutes: 60,
    enabled: true,
    nextRunAt: T0 + 3_600_000,
    hasWebhookSecret: true,
    ...overrides,
  };
}

test("the section renders its heading, create form, and loading state", async () => {
  const { SchedulesSection } = await load();
  const markup = renderToStaticMarkup(h(SchedulesSection, {}));
  assert.match(markup, /Schedules/);
  assert.match(markup, /schedule-create-name/);
  assert.match(markup, /schedule-create-prompt/);
  assert.match(markup, /schedule-create-interval/);
  assert.match(markup, /Add schedule/);
  assert.match(markup, /Loading schedules/);
});

test("the list shows each schedule with cadence, next run, and actions", async () => {
  const { SchedulesList } = await load();
  const noop = () => undefined;
  const markup = renderToStaticMarkup(
    h(SchedulesList, {
      schedules: [
        schedule(),
        schedule({
          id: "sch_00000000-0000-0000-0000-000000000002",
          name: "Nightly cleanup",
          prompt: "Tidy the workspace.",
          intervalMinutes: 30,
          enabled: false,
          nextRunAt: T0 + 1_800_000,
        }),
      ],
      busyId: null,
      confirmDeleteId: null,
      onToggle: noop,
      onDelete: noop,
      onConfirmDelete: noop,
      onCancelDelete: noop,
    }),
  );
  assert.match(markup, /Morning brief/);
  assert.match(markup, /every hour/);
  assert.match(markup, /Nightly cleanup/);
  assert.match(markup, /every 30 min/);
  assert.match(markup, /Paused/);
  assert.match(markup, /Pause/);
  assert.match(markup, /Resume/);
  assert.match(markup, /Delete/);
});

test("an empty list explains itself", async () => {
  const { SchedulesList } = await load();
  const noop = () => undefined;
  const markup = renderToStaticMarkup(
    h(SchedulesList, {
      schedules: [],
      busyId: null,
      confirmDeleteId: null,
      onToggle: noop,
      onDelete: noop,
      onConfirmDelete: noop,
      onCancelDelete: noop,
    }),
  );
  assert.match(markup, /No schedules yet/);
});

test("interval and next-run labels read like plain language", () => {
  assert.equal(formatInterval(5), "every 5 min");
  assert.equal(formatInterval(60), "every hour");
  assert.equal(formatInterval(120), "every 2 hours");
  assert.equal(formatInterval(1440), "every day");
  assert.equal(formatNextRun(T0, T0), "due now");
  assert.equal(formatNextRun(T0 - 1_000, T0), "due now");
  assert.equal(formatNextRun(T0 + 5 * 60_000, T0), "in 5 min");
  assert.equal(formatNextRun(T0 + 2 * 3_600_000, T0), "in 2 h");
  assert.equal(formatNextRun(T0 + 90 * 60_000, T0), "in 1 h 30 min");
});
