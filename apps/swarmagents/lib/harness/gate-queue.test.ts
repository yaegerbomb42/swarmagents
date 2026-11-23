import test from "node:test";
import assert from "node:assert/strict";
import { GateQueue } from "./gate-queue";

test("GateQueue runs enqueued gates in order", async () => {
  const gates = new GateQueue();
  const order: number[] = [];
  const p1 = gates.enqueue(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push(1);
    return "first";
  });
  const p2 = gates.enqueue(async () => {
    order.push(2);
    return "second";
  });
  assert.deepEqual(await Promise.all([p1, p2]), ["first", "second"]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(gates.size, 0);
});

test("GateQueue isolates a throwing gate: later gates still run", async () => {
  const gates = new GateQueue();
  const errors: unknown[] = [];
  const ran: string[] = [];
  const p1 = gates.enqueue(async () => {
    throw new Error("boom");
  }, {
    onError: (err) => {
      errors.push(err);
    },
  });
  const p2 = gates.enqueue(async () => {
    ran.push("second");
    return 42;
  });
  assert.equal(await p1, undefined);
  assert.equal(await p2, 42);
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /boom/);
  assert.deepEqual(ran, ["second"]);
  await gates.drain();
  assert.equal(gates.size, 0);
});

test("GateQueue drain waits for queued gates and never rejects", async () => {
  const gates = new GateQueue();
  gates.enqueue(async () => {
    throw new Error("poison");
  });
  gates.enqueue(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await gates.drain();
  assert.equal(gates.size, 0);
  // The queue stays usable after a failure.
  assert.equal(await gates.enqueue(async () => "ok"), "ok");
});
