import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PendingInteractionStore,
  type BasePendingInteraction,
} from "./pending-store";

interface TestItem extends BasePendingInteraction {
  label: string;
}

type TestOutcome = { status: "answered" } | { status: "expired" } | { status: "cancelled" };

class TestStore extends PendingInteractionStore<TestItem, TestOutcome> {
  private readonly ttlMs: number;

  constructor(options: { filePath: string; persist?: boolean; ttlMs?: number; now?: () => number }) {
    super({
      filePath: options.filePath,
      persist: options.persist,
      now: options.now,
      auditExpireAction: "question.expire",
      normalize: (raw, nowMs) => {
        if (!raw || typeof raw !== "object") return null;
        const item = raw as Partial<TestItem>;
        if (typeof item.id !== "string" || typeof item.label !== "string") return null;
        const expiresAt = typeof item.expiresAt === "number" ? item.expiresAt : nowMs;
        return {
          id: item.id,
          runId: typeof item.runId === "string" ? item.runId : "",
          userId: typeof item.userId === "string" ? item.userId : "",
          label: item.label,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : nowMs,
          expiresAt,
          status:
            item.status === "pending" && expiresAt <= nowMs
              ? "expired"
              : item.status === "answered" || item.status === "expired" || item.status === "cancelled"
                ? item.status
                : "pending",
        };
      },
      expiredOutcome: () => ({ status: "expired" }),
      cancelledOutcome: () => ({ status: "cancelled" }),
    });
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  create(id: string, runId = "run-1"): TestItem {
    const now = this.now();
    return this.createPending(
      {
        id,
        runId,
        userId: "user-1",
        label: id,
        createdAt: now,
        expiresAt: now + this.ttlMs,
        status: "pending",
      },
      this.ttlMs,
    );
  }

  resolve(id: string): TestItem | undefined {
    return this.settle(id, (item) => {
      item.status = "answered";
      return { status: "answered" };
    });
  }
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pending-store-")), "items.json");
}

test("pending store: create + resolve settles the waiter", async () => {
  const store = new TestStore({ filePath: tmpFile(), persist: false });
  const item = store.create("t-1");
  assert.equal(item.status, "pending");
  const waiter = store.waitFor("t-1");
  store.resolve("t-1");
  assert.deepEqual(await waiter, { status: "answered" });
  assert.equal(store.get("t-1")?.status, "answered");
});

test("pending store: clear() resolves outstanding waiters as cancelled", async () => {
  const store = new TestStore({ filePath: tmpFile(), persist: false });
  store.create("t-1");
  const waiter = store.waitFor("t-1");
  store.clear();
  assert.deepEqual(await waiter, { status: "cancelled" });
  assert.equal(store.get("t-1"), undefined);
});

test("pending store: a duplicate id cancels the prior waiter", async () => {
  const store = new TestStore({ filePath: tmpFile(), persist: false });
  store.create("t-1");
  const firstWaiter = store.waitFor("t-1");
  store.create("t-1");
  assert.deepEqual(await firstWaiter, { status: "cancelled" });
  assert.equal(store.get("t-1")?.status, "pending");
  assert.deepEqual(store.listPending().map((i) => i.id), ["t-1"]);
});

test("pending store: restored pending items expire after a restart", async () => {
  const file = tmpFile();
  // Controlled clock: the first create() (with its fsync) can take longer
  // than the 15ms TTL on a slow machine, which would expire the item
  // before the second store even loads it. Freezing `now` keeps the
  // restored item pending until the real 15ms timer fires it.
  let now = 1_000_000;
  const first = new TestStore({ filePath: file, ttlMs: 15, now: () => now });
  first.create("t-1");
  const second = new TestStore({ filePath: file, ttlMs: 15, now: () => now });
  assert.deepEqual(second.listPending().map((i) => i.id), ["t-1"]);
  const waiter = second.waitFor("t-1");
  assert.deepEqual(await waiter, { status: "expired" });
  assert.equal(second.get("t-1")?.status, "expired");
});

test("pending store: cancelPendingForRun only touches its run", async () => {
  const store = new TestStore({ filePath: tmpFile(), persist: false });
  store.create("t-1", "run-1");
  store.create("t-2", "run-2");
  const waiter = store.waitFor("t-1");
  store.cancelPendingForRun("run-1");
  assert.deepEqual(await waiter, { status: "cancelled" });
  assert.deepEqual(store.listPending().map((i) => i.id), ["t-2"]);
});
