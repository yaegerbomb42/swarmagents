import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FairTenantQueue, QueueWaitTimeoutError } from "./fair-queue";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("FairTenantQueue wait timeout", () => {
  it("rejects and dequeues a task that waits past waitTimeoutMs", async () => {
    const q = new FairTenantQueue(1);
    const releases: Record<string, () => void> = {};
    const first = q.enqueue("A", "A1", () => true, (release) => {
      releases.A1 = release;
      return "A1";
    });
    assert.equal(await first, "A1");

    const stuck = q.enqueue("A", "A2", () => true, () => "A2", { waitTimeoutMs: 20 });
    await assert.rejects(stuck, (err: unknown) => {
      assert.ok(err instanceof QueueWaitTimeoutError);
      assert.equal((err as QueueWaitTimeoutError).code, "QUEUE_WAIT_TIMEOUT");
      return true;
    });
    assert.equal(q.queuedCount, 0, "timed-out task is dequeued");
    assert.equal(q.activeInFlight, 1, "the running task still holds its slot");

    releases.A1!();
    assert.equal(q.activeInFlight, 0);
    const third = await q.enqueue("A", "A3", () => true, (release) => {
      release();
      return "A3";
    });
    assert.equal(third, "A3", "queue stays usable after a timeout");
  });

  it("a task whose canRunNow never turns true times out instead of waiting forever", async () => {
    const q = new FairTenantQueue(10);
    const stuck = q.enqueue("A", "A1", () => false, () => "A1", { waitTimeoutMs: 20 });
    await assert.rejects(stuck, QueueWaitTimeoutError);
    assert.equal(q.queuedCount, 0);
    assert.equal(q.activeInFlight, 0);
  });

  it("timing out a blocked head task lets the user's next task dispatch", async () => {
    const q = new FairTenantQueue(10);
    const order: string[] = [];
    const blocked = q.enqueue(
      "A",
      "A1",
      () => false,
      () => {
        order.push("A1");
        return "A1";
      },
      { waitTimeoutMs: 20 },
    );
    const next = q.enqueue("A", "A2", () => true, (release) => {
      order.push("A2");
      release();
      return "A2";
    });
    await assert.rejects(blocked, QueueWaitTimeoutError);
    assert.equal(await next, "A2");
    assert.deepEqual(order, ["A2"]);
  });

  it("a task dispatched before its timeout resolves normally", async () => {
    const q = new FairTenantQueue(1);
    const result = await q.enqueue(
      "A",
      "A1",
      () => true,
      (release) => {
        release();
        return 42;
      },
      { waitTimeoutMs: 1_000 },
    );
    assert.equal(result, 42);
    assert.equal(q.activeInFlight, 0);
    assert.equal(q.queuedCount, 0);
  });

  it("an infinite waitTimeoutMs does not arm a near-immediate timer", async () => {
    const q = new FairTenantQueue(1);
    const releases: Record<string, () => void> = {};
    await q.enqueue("A", "A1", () => true, (release) => {
      releases.A1 = release;
      return "A1";
    });
    let started = false;
    const waiting = q.enqueue(
      "A",
      "A2",
      () => true,
      (release) => {
        started = true;
        release();
        return "A2";
      },
      { waitTimeoutMs: Number.POSITIVE_INFINITY },
    );
    await tick();
    await tick();
    assert.equal(started, false, "still queued behind A1, not timed out");
    releases.A1!();
    assert.equal(await waiting, "A2");
  });
});
