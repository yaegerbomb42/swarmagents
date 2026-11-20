/**
 * F4 — test-drive background sweeper: an abandoned drive is rolled back
 * by the timer alone, with no manual trigger (no route read, no POST
 * sweep, no next drive start).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir } from "./user-store";
import { createTestDrive, getTestDrive, updateTestDrive } from "./test-drive";
import type { TestDriveRecord } from "./test-drive";
import {
  DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_MS,
  TestDriveSweeper,
  resolveTestDriveSweepIntervalMs,
  startTestDriveSweeper,
  stopTestDriveSweeper,
} from "./test-drive-sweeper";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-drive-sweeper-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  stopTestDriveSweeper();
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function seedDrive(
  runId: string,
  input: {
    userId?: string;
    status: "running" | "awaiting-decision" | "kept" | "rolled-back";
    ageDays: number;
  },
): string {
  const drive = createTestDrive({
    userId: input.userId ?? "local_alice@example.com",
    publicId: "pub_abc",
    publicName: "Try me",
    version: 1,
    snapshotLabel: `test-drive-${runId}`,
    runId,
  });
  updateTestDrive(drive.id, {
    status: input.status,
    startedAt: NOW - input.ageDays * DAY_MS,
    finishedAt: input.status === "running" ? undefined : NOW - input.ageDays * DAY_MS,
  });
  return drive.id;
}

// Fake interval scheduler: deterministic time, no wall-clock waiting
// (same shape as the one in lib/vm/idle.test.ts).
type TimerFn = () => void | Promise<unknown>;

class FakeTimers {
  private handlers = new Map<number, { fn: TimerFn; ms: number; next: number }>();
  private nextId = 1;
  private current = 0;

  readonly setInterval = (fn: TimerFn, ms: number): number => {
    const id = this.nextId++;
    this.handlers.set(id, { fn, ms, next: this.current + ms });
    return id;
  };

  readonly clearInterval = (handle: unknown): void => {
    this.handlers.delete(handle as number);
  };

  get pending(): number {
    return this.handlers.size;
  }

  /** Advance the fake timers, firing every due interval in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, h] of this.handlers) {
        if (h.next <= target && h.next < dueAt) {
          dueId = id;
          dueAt = h.next;
        }
      }
      if (dueId === null) break;
      const handler = this.handlers.get(dueId)!;
      handler.next = dueAt + handler.ms;
      this.current = dueAt;
      const result = handler.fn();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        await result;
      }
    }
    this.current = target;
  }
}

function makeSweeper(
  timers: FakeTimers,
  opts: {
    restore: (drive: TestDriveRecord) => Promise<void>;
    isUserBusy?: (userId: string) => boolean;
    intervalMs?: number;
    maxAgeMs?: number;
  },
): TestDriveSweeper {
  return new TestDriveSweeper({
    restore: opts.restore,
    intervalMs: opts.intervalMs ?? 1000,
    now: NOW,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
    ...(opts.isUserBusy ? { isUserBusy: opts.isUserBusy } : {}),
    ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
  });
}

test("resolveTestDriveSweepIntervalMs defaults to hourly and honors the env var", () => {
  assert.equal(resolveTestDriveSweepIntervalMs(), DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_MS);
  assert.equal(DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_MS, 60 * 60 * 1000);
  const prev = process.env.SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC;
  try {
    process.env.SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC = "120";
    assert.equal(resolveTestDriveSweepIntervalMs(), 120_000);
    process.env.SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC = "bogus";
    assert.equal(resolveTestDriveSweepIntervalMs(), DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_MS);
  } finally {
    if (prev === undefined) delete process.env.SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC;
    else process.env.SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC = prev;
  }
});

test("the timer alone sweeps a stale awaiting-decision drive — no manual trigger", async () => {
  const stale = seedDrive("run_stale", { status: "awaiting-decision", ageDays: 8 });
  const fresh = seedDrive("run_fresh", { status: "awaiting-decision", ageDays: 1 });
  const restored: string[] = [];
  const timers = new FakeTimers();
  const sweeper = makeSweeper(timers, {
    restore: async (drive) => {
      restored.push(drive.id);
    },
  });
  sweeper.start();
  assert.equal(sweeper.running, true);

  // Nothing has fired yet: no restore, no status change.
  assert.deepEqual(restored, []);
  assert.equal(getTestDrive(stale)?.status, "awaiting-decision");

  await timers.advance(1000);

  assert.deepEqual(restored, [stale]);
  assert.equal(getTestDrive(stale)?.status, "rolled-back");
  assert.equal(getTestDrive(stale)?.rollbackReason, "abandoned");
  // The fresh drive (1 day old) is left alone.
  assert.equal(getTestDrive(fresh)?.status, "awaiting-decision");
  sweeper.stop();
});

test("start() twice schedules only one timer; stop() cancels it", async () => {
  const stale = seedDrive("run_stale", { status: "awaiting-decision", ageDays: 8 });
  const restored: string[] = [];
  const timers = new FakeTimers();
  const sweeper = makeSweeper(timers, {
    restore: async (drive) => {
      restored.push(drive.id);
    },
  });
  sweeper.start();
  sweeper.start();
  assert.equal(timers.pending, 1);

  sweeper.stop();
  assert.equal(sweeper.running, false);
  assert.equal(timers.pending, 0);
  await timers.advance(5000);
  assert.deepEqual(restored, []);
  assert.equal(getTestDrive(stale)?.status, "awaiting-decision");
});

test("startTestDriveSweeper returns one process-wide sweeper", () => {
  const timers = new FakeTimers();
  const first = startTestDriveSweeper(async () => {}, {
    intervalMs: 1000,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  const second = startTestDriveSweeper(async () => {}, {
    intervalMs: 1000,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  assert.equal(second, first);
  assert.equal(timers.pending, 1);
  stopTestDriveSweeper();
  assert.equal(timers.pending, 0);
  assert.equal(first.running, false);
});

test("a busy user's drives wait for the next tick", async () => {
  const stale = seedDrive("run_stale", { status: "awaiting-decision", ageDays: 8 });
  const restored: string[] = [];
  const timers = new FakeTimers();
  let busy = true;
  const sweeper = makeSweeper(timers, {
    restore: async (drive) => {
      restored.push(drive.id);
    },
    isUserBusy: () => busy,
  });
  sweeper.start();

  // Tick while the user has a run in flight: nothing is restored — a
  // restore mid-run would clobber the run's VM state.
  await timers.advance(1000);
  assert.deepEqual(restored, []);
  assert.equal(getTestDrive(stale)?.status, "awaiting-decision");

  busy = false;
  await timers.advance(1000);
  assert.deepEqual(restored, [stale]);
  assert.equal(getTestDrive(stale)?.status, "rolled-back");
  sweeper.stop();
});

test("the timer sweeps every account, and a restore failure blocks nothing", async () => {
  const aliceStale = seedDrive("run_alice", {
    userId: "local_alice@example.com",
    status: "awaiting-decision",
    ageDays: 8,
  });
  const bobStale = seedDrive("run_bob", {
    userId: "local_bob@example.com",
    status: "awaiting-decision",
    ageDays: 9,
  });
  const restored: string[] = [];
  const timers = new FakeTimers();
  const sweeper = makeSweeper(timers, {
    restore: async (drive) => {
      if (drive.id === aliceStale) throw new Error("snapshot gone");
      restored.push(drive.id);
    },
  });
  sweeper.start();
  await timers.advance(1000);

  // Bob's drive was swept even though Alice's restore failed.
  assert.deepEqual(restored, [bobStale]);
  assert.equal(getTestDrive(bobStale)?.status, "rolled-back");
  // Alice's drive stays awaiting-decision with the failure recorded.
  assert.equal(getTestDrive(aliceStale)?.status, "awaiting-decision");
  assert.match(getTestDrive(aliceStale)?.lastError ?? "", /snapshot gone/);
  sweeper.stop();
});

test("overlapping sweeps collapse into one follow-up pass", async () => {
  const stale = seedDrive("run_stale", { status: "awaiting-decision", ageDays: 8 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restoreCalls = 0;
  const sweeper = new TestDriveSweeper({
    restore: async () => {
      restoreCalls += 1;
      await gate;
    },
    intervalMs: 1000,
    now: NOW,
  });

  const first = sweeper.sweep();
  const second = sweeper.sweep();
  // The second call collapses: it returns immediately with no results
  // and queues exactly one follow-up pass.
  assert.deepEqual(await second, []);
  release();
  const results = await first;
  // Pass 1 swept the drive; the queued follow-up pass found nothing left
  // (sweep() returns the last pass's results), and the restore ran once.
  assert.equal(restoreCalls, 1);
  assert.deepEqual(
    results.map((r) => r.swept),
    [[]],
  );
  assert.equal(getTestDrive(stale)?.status, "rolled-back");
});
