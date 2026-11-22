/**
 * Unit tests for role-escalation waits (lib/harness/role-escalation.ts).
 *
 * The acceptance criteria this locks in:
 *   - aborting the run expires the pending approval record (run_cancelled,
 *     never a TTL timeout) and detaches the abort listener;
 *   - a verdict that arrives first leaves the record decided, not expired,
 *     and still detaches the listener;
 *   - an already-aborted signal expires the record immediately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "./approvals";
import { awaitRoleEscalation } from "./role-escalation";
import type { TelemetryEvent } from "./types";

/** A minimal AbortSignal stand-in that records listener attach/detach. */
function fakeSignal(): {
  signal: AbortSignal;
  listeners: Set<() => void>;
  abort: () => void;
} {
  const listeners = new Set<() => void>();
  const raw = {
    aborted: false,
    addEventListener(_type: string, fn: () => void) {
      listeners.add(fn);
    },
    removeEventListener(_type: string, fn: () => void) {
      listeners.delete(fn);
    },
  };
  const signal = raw as unknown as AbortSignal;
  return {
    signal,
    listeners,
    abort() {
      raw.aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
}

function setup(): {
  store: ApprovalStore;
  approval: ReturnType<ApprovalStore["create"]>;
  events: TelemetryEvent[];
} {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const approval = store.create({
    runId: "run_1",
    userId: "alice",
    toolName: "set_role",
    action: "Researcher → Deployer: adds Shell",
    reason: "This role switch adds access the run did not start with.",
    kind: "role_escalation",
  });
  const events: TelemetryEvent[] = [];
  return { store, approval, events };
}

test("awaitRoleEscalation expires the record and detaches the listener on abort", async () => {
  const { store, approval, events } = setup();
  const { signal, listeners, abort } = fakeSignal();
  const verdictPromise = awaitRoleEscalation(approval, {
    publish: (event) => events.push(event),
    signal,
    store,
  });
  assert.equal(listeners.size, 1);
  abort();
  assert.equal(await verdictPromise, "expired");
  assert.equal(listeners.size, 0, "the listener must be detached after the wait settles");
  const record = store.get(approval.id);
  assert.equal(record?.status, "expired");
  assert.equal(record?.expiredReason, "run_cancelled");
  assert.equal(record?.timedOut, undefined, "an abort is not a TTL timeout");
  assert.equal(
    events.some((event) => event.type === "approval.timeout"),
    false,
    "an abort must not emit a timeout event",
  );
  assert.equal(
    events.some((event) => event.type === "approval.resolved"),
    true,
    "the wait still resolves",
  );
});

test("awaitRoleEscalation keeps the record decided when the verdict arrives first", async () => {
  const { store, approval, events } = setup();
  const { signal, listeners } = fakeSignal();
  const verdictPromise = awaitRoleEscalation(approval, {
    publish: (event) => events.push(event),
    signal,
    store,
  });
  store.resolve(approval.id, "approved");
  assert.equal(await verdictPromise, "approved");
  assert.equal(listeners.size, 0, "the listener must be detached after the wait settles");
  assert.equal(store.get(approval.id)?.status, "approved");
  assert.equal(store.get(approval.id)?.expiredReason, undefined);
});

test("awaitRoleEscalation expires the record for an already-aborted signal", async () => {
  const { store, approval, events } = setup();
  const { signal, listeners, abort } = fakeSignal();
  abort();
  const verdict = await awaitRoleEscalation(approval, {
    publish: (event) => events.push(event),
    signal,
    store,
  });
  assert.equal(verdict, "expired");
  assert.equal(listeners.size, 0, "no listener may be added for an already-aborted signal");
  assert.equal(store.get(approval.id)?.status, "expired");
  assert.equal(store.get(approval.id)?.expiredReason, "run_cancelled");
});
