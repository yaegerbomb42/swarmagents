import test from "node:test";
import assert from "node:assert/strict";
import {
  latestVmLifecycleEvent,
  resolveVmDisplayStatus,
  VM_STATUS_POLL_MS,
} from "./vmStatus";

test("no signal yet defaults to ready", () => {
  const display = resolveVmDisplayStatus({});
  assert.equal(display.state, "ready");
  assert.equal(display.label, "Ready");
  assert.match(display.tooltip, /ready/i);
});

test("vm.starting maps to starting", () => {
  const display = resolveVmDisplayStatus({ latestVmEvent: "vm.starting" });
  assert.equal(display.state, "starting");
  assert.equal(display.label, "Starting");
  assert.match(display.tooltip, /starting up/i);
});

test("vm.ready maps to ready", () => {
  const display = resolveVmDisplayStatus({ latestVmEvent: "vm.ready" });
  assert.equal(display.state, "ready");
});

test("vm.error maps to error with the generic tooltip", () => {
  const display = resolveVmDisplayStatus({ latestVmEvent: "vm.error" });
  assert.equal(display.state, "error");
  assert.equal(display.label, "Error");
  assert.match(display.tooltip, /reported an error/i);
});

test("vm.error carries its message into the tooltip", () => {
  const display = resolveVmDisplayStatus({
    latestVmEvent: "vm.error",
    errorMessage: "container failed to start",
  });
  assert.equal(display.state, "error");
  assert.match(display.tooltip, /container failed to start/);
});

test("a reset in flight maps to starting even over vm.ready", () => {
  const display = resolveVmDisplayStatus({ latestVmEvent: "vm.ready", resetting: true });
  assert.equal(display.state, "starting");
});

test("polled creating maps to starting", () => {
  assert.equal(resolveVmDisplayStatus({ polledStatus: "creating" }).state, "starting");
});

test("polled running maps to ready", () => {
  assert.equal(resolveVmDisplayStatus({ polledStatus: "running" }).state, "ready");
});

test("polled stopped maps to hibernated", () => {
  const display = resolveVmDisplayStatus({ polledStatus: "stopped" });
  assert.equal(display.state, "hibernated");
  assert.equal(display.label, "Hibernated");
  assert.match(display.tooltip, /hibernated/i);
  assert.match(display.tooltip, /wake automatically/i);
});

test("polled missing maps to hibernated", () => {
  assert.equal(resolveVmDisplayStatus({ polledStatus: "missing" }).state, "hibernated");
});

test("polled error maps to error", () => {
  assert.equal(resolveVmDisplayStatus({ polledStatus: "error" }).state, "error");
});

test("error beats starting", () => {
  const display = resolveVmDisplayStatus({
    latestVmEvent: "vm.error",
    polledStatus: "creating",
    resetting: true,
  });
  assert.equal(display.state, "error");
});

test("starting beats hibernated: a waking VM is starting, not hibernated", () => {
  const display = resolveVmDisplayStatus({
    latestVmEvent: "vm.starting",
    polledStatus: "stopped",
  });
  assert.equal(display.state, "starting");
});

test("vm.ready beats a stale stopped poll", () => {
  const display = resolveVmDisplayStatus({
    latestVmEvent: "vm.ready",
    polledStatus: "stopped",
  });
  assert.equal(display.state, "ready");
});

test("polled error beats a vm.ready event", () => {
  const display = resolveVmDisplayStatus({
    latestVmEvent: "vm.ready",
    polledStatus: "error",
  });
  assert.equal(display.state, "error");
});

test("latestVmLifecycleEvent picks the last vm event and ignores other kinds", () => {
  assert.equal(
    latestVmLifecycleEvent([
      { kind: "run.created" },
      { kind: "vm.starting" },
      { kind: "assistant.text" },
      { kind: "vm.ready" },
      { kind: "tool.call" },
    ]),
    "vm.ready",
  );
  assert.equal(latestVmLifecycleEvent([{ kind: "run.created" }]), undefined);
  assert.equal(latestVmLifecycleEvent([]), undefined);
});

test("latestVmLifecycleEvent lets a later vm.ready clear an earlier vm.error", () => {
  assert.equal(
    latestVmLifecycleEvent([{ kind: "vm.error" }, { kind: "vm.ready" }]),
    "vm.ready",
  );
});

test("poll interval is a sane 30s", () => {
  assert.equal(VM_STATUS_POLL_MS, 30_000);
});
