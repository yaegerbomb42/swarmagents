import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { WORKSPACE_ROOT } from "../vm/files";
import type { BrowserControl } from "../browser/manager";
import { RunReporter } from "./run-reporter";
import { readRunReport } from "./run-report";
import { auditFilePath, readRunAudit } from "../lenses/audit";
import type { RunAudit } from "./run-report-types";

/** Fake driver with an overridable /workspace file listing for `find`. */
class FakeFindDriver extends FakeVmDriver {
  entries = new Map<string, { size: number; mtimeMs: number }>();

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "find") {
      // Mimic the real `find ... ! -path /workspace/.swarm/*` exclusion.
      const excludesSwarm = cmd.includes("-path") && cmd.some((arg) => arg.includes(".swarm"));
      const out: string[] = [];
      for (const [file, entry] of this.entries) {
        if (excludesSwarm && file.startsWith(`${WORKSPACE_ROOT}/.swarm/`)) continue;
        out.push(file, String(entry.size), (entry.mtimeMs / 1000).toFixed(3));
      }
      if (out.length > 0) opts?.onStdout?.(`${out.join("\0")}\0`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

/** Fake driver with a configured VM image, like the docker driver. */
class ImagedFindDriver extends FakeFindDriver {
  image = "swarm-vm:custom";
}

/** Browser stub that always "captures" a tiny JPEG frame. */
class StubBrowser implements BrowserControl {
  shots = 0;
  async navigate(): Promise<never> {
    throw new Error("not used");
  }
  async screenshot(): Promise<never> {
    throw new Error("not used");
  }
  async getFrame(): Promise<{ frameId: number; jpeg: Buffer; width: number; height: number; capturedAt: number }> {
    this.shots += 1;
    return { frameId: this.shots, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), width: 2, height: 2, capturedAt: Date.now() };
  }
  async act(): Promise<never> {
    throw new Error("not used");
  }
  async evaluate(): Promise<never> {
    throw new Error("not used");
  }
  async getDiagnostics(): Promise<never> {
    throw new Error("not used");
  }
  async close(): Promise<void> {}
  getMode(): "host" {
    return "host";
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-reporter-"));
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(driver: FakeFindDriver, runsDir: string, maxStepShots?: number) {
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const vm = new VmManager({ customDriver: driver });
  const browser = new StubBrowser();
  const reporter = new RunReporter({ vm, bus, browser, runsDir: () => runsDir, maxStepShots });
  return { bus, reporter, browser, vm };
}

test("reporter records the driver's VM image in the report meta", async () => {
  const runsDir = tmpDir();
  try {
    // A driver with a configured image: the report names the actual image.
    const imaged = new ImagedFindDriver();
    const { bus, reporter } = setup(imaged, runsDir);
    const runId = "run_img";
    reporter.attach(runId, "alice");
    bus.publish(runId, { type: "run.created", data: { prompt: "build it", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "run.finished", exitCode: 0 } as never);
    await waitFor(() => (reporter.hasReport(runId) ? true : null));
    assert.equal(readRunReport(runId, runsDir)?.meta.vmImage, "swarm-vm:custom");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter leaves vmImage unset for image-less drivers", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir);
    const runId = "run_noimg";
    reporter.attach(runId, "alice");
    bus.publish(runId, { type: "run.created", data: { prompt: "build it", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "run.finished", exitCode: 0 } as never);
    await waitFor(() => (reporter.hasReport(runId) ? true : null));
    assert.equal(readRunReport(runId, runsDir)?.meta.vmImage, undefined);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter unsubscribes from the bus once the run reaches a terminal event", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir);
    const runId = "run_unsub";
    reporter.attach(runId, "alice");
    assert.equal(bus.subscriberCount(runId), 1);
    bus.publish(runId, { type: "run.created", data: { prompt: "build it", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    // The terminal step runs on the reporter's serialized chain; wait for
    // the report, then the unsubscribe must have happened too.
    bus.publish(runId, { type: "run.finished", exitCode: 0 } as never);
    await waitFor(() => (reporter.hasReport(runId) ? true : null));
    await waitFor(() => (bus.subscriberCount(runId) === 0 ? true : null));
    assert.equal(bus.subscriberCount(runId), 0);
    // A late event for the finished run is ignored, not resurrected.
    bus.publish(runId, { type: "computer.action", data: { action: "late" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bus.subscriberCount(runId), 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter detaches when the caller drops the attach handle", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir);
    const runId = "run_detach";
    const detach = reporter.attach(runId, "alice");
    assert.equal(bus.subscriberCount(runId), 1);
    detach();
    assert.equal(bus.subscriberCount(runId), 0);
    // Detaching twice is a no-op, not a crash.
    detach();
    assert.equal(bus.subscriberCount(runId), 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter creates a report with steps and start/end screenshots on success", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir);
    const runId = "run_1";
    reporter.attach(runId, "alice");
    bus.publish(runId, { type: "run.created", data: { prompt: "build it", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "run.started", sessionId: "s1", model: "claude-sonnet-5-5", provider: "anthropic" } as never);
    bus.publish(runId, { type: "computer.action", action: "Clicking Sign in" } as never);
    bus.publish(runId, { type: "computer.action", action: "Typing hello" } as never);
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.25, durationMs: 1000, numTurns: 2 } as never);

    const report = await waitFor(() => readRunReport(runId, runsDir));
    assert.equal(report.status, "finished");
    assert.equal(report.userId, "alice");
    assert.equal(report.prompt, "build it");
    assert.equal(report.meta.costUsd, 0.25);
    assert.deepEqual(report.meta.providers, ["anthropic"]);
    assert.equal(report.steps[0].kind, "start");
    assert.equal(report.steps[report.steps.length - 1].kind, "end");
    // Steps include the two desktop actions in order.
    const desktop = report.steps.filter((step) => step.kind === "desktop");
    assert.deepEqual(desktop.map((step) => step.text), ["Clicking Sign in", "Typing hello"]);
    // Start + 2 action shots + end = 4 screenshots.
    assert.equal(report.shots.length, 4);
    assert.equal(report.shots[0].label, "Start");
    assert.equal(report.shots[report.shots.length - 1].label, "End");
    assert.equal(report.meta.artifacts, 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter creates a report with artifacts diffed from the workspace listing", async () => {
  const runsDir = tmpDir();
  try {
    const driver = new FakeFindDriver();
    driver.entries.set("/workspace/existing.txt", { size: 4, mtimeMs: 1_000 });
    const { bus, reporter, vm } = setup(driver, runsDir);
    const runId = "run_2";
    await vm.ensure("bob");
    reporter.attach(runId, "bob");
    bus.publish(runId, { type: "run.created", data: { prompt: "edit files", userId: "bob" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    // Give the reporter's start-of-run listing a tick to capture the pre-run
    // state before the agent "changes" files.
    await new Promise((resolve) => setTimeout(resolve, 50));
    driver.entries.set("/workspace/new.txt", { size: 10, mtimeMs: 2_000 });
    driver.entries.set("/workspace/existing.txt", { size: 99, mtimeMs: 2_500 });
    driver.entries.set("/workspace/.swarm/mcp.json", { size: 3, mtimeMs: 2_100 }); // system-seeded, must be ignored via find filter
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);

    const report = await waitFor(() => readRunReport(runId, runsDir));
    assert.deepEqual(
      report.artifacts.map((artifact) => [artifact.rel, artifact.change]),
      [
        ["existing.txt", "modified"],
        ["new.txt", "created"],
      ],
    );
    // Note: .swarm seed files are excluded server-side by the find filter, so
    // they do not appear in this fake listing-driven test.
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter counts a file the Write telemetry proves it wrote, even when the start listing already has it", async () => {
  const runsDir = tmpDir();
  try {
    const driver = new FakeFindDriver();
    // The file is already in the workspace before vm.ready: the start listing
    // (captured asynchronously after vm.ready) already contains it, so the
    // listing diff alone would report 0 files changed — the live bug. The
    // run's own Write call is the proof the run wrote it.
    driver.entries.set("/workspace/hello.txt", { size: 23, mtimeMs: 2_000 });
    const { bus, reporter, vm } = setup(driver, runsDir);
    const runId = "run_write_proof";
    await vm.ensure("alice");
    reporter.attach(runId, "alice");
    bus.publish(runId, { type: "run.created", data: { prompt: "create hello.txt", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "tool.call", name: "Write", id: "t1", input: { file_path: "/workspace/hello.txt" } } as never);
    bus.publish(runId, { type: "tool.result", id: "t1", ok: true } as never);
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);

    const report = await waitFor(() => readRunReport(runId, runsDir));
    assert.equal(report.meta.artifacts, 1);
    // The file is in the (raced) start baseline, so the telemetry-derived
    // entry is labelled "modified" — the point is the count: the diff alone
    // reported 0, the Write telemetry proves the run wrote the file.
    assert.deepEqual(
      report.artifacts.map((artifact) => [artifact.rel, artifact.change]),
      [["hello.txt", "modified"]],
    );
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter samples action screenshots to the cap but keeps start and end", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir, 3);
    const runId = "run_3";
    reporter.attach(runId, "carol");
    bus.publish(runId, { type: "run.created", data: { prompt: "click around", userId: "carol" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    for (let i = 0; i < 10; i++) {
      bus.publish(runId, { type: "computer.action", action: `Action ${i}` } as never);
    }
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);

    const report = await waitFor(() => readRunReport(runId, runsDir));
    // start + capped actions (3) + end = 5 total.
    assert.equal(report.shots.length, 5);
    assert.equal(report.shots[0].label, "Start");
    assert.equal(report.shots[report.shots.length - 1].label, "End");
    const actions = report.shots.filter((shot) => shot.label === "Action");
    assert.equal(actions.length, 3);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter creates a report on failure and cancellation", async () => {
  const runsDir = tmpDir();
  try {
    const { bus, reporter } = setup(new FakeFindDriver(), runsDir);
    const runIdError = "run_err";
    reporter.attach(runIdError, "dave");
    bus.publish(runIdError, { type: "run.created", data: { prompt: "fail", userId: "dave" } });
    bus.publish(runIdError, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runIdError, { type: "run.error", message: "claude exited with code 1" } as never);
    const errorReport = await waitFor(() => readRunReport(runIdError, runsDir));
    assert.equal(errorReport.status, "error");
    assert.equal(errorReport.steps[errorReport.steps.length - 1].kind, "end");
    assert.ok(errorReport.steps[errorReport.steps.length - 1].text.includes("Error"));

    const runIdCancel = "run_cancel";
    reporter.attach(runIdCancel, "dave");
    bus.publish(runIdCancel, { type: "run.created", data: { prompt: "stop", userId: "dave" } });
    bus.publish(runIdCancel, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runIdCancel, { type: "run.cancelled", reason: "user" } as never);
    const cancelReport = await waitFor(() => readRunReport(runIdCancel, runsDir));
    assert.equal(cancelReport.status, "cancelled");
    assert.ok(cancelReport.steps[cancelReport.steps.length - 1].text.includes("Stopped"));
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter degrades to text-only when no screenshot source works", async () => {
  const runsDir = tmpDir();
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
    const vm = new VmManager({ customDriver: new FakeFindDriver() });
    const reporter = new RunReporter({ vm, bus, browser: null, runsDir: () => runsDir });
    const runId = "run_4";
    reporter.attach(runId, "erin");
    bus.publish(runId, { type: "run.created", data: { prompt: "terminal only", userId: "erin" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);
    const report = await waitFor(() => readRunReport(runId, runsDir));
    assert.equal(report.shots.length, 0);
    assert.ok(report.steps.length > 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter runs a background audit when the run's role pins a lens", async () => {
  const runsDir = tmpDir();
  try {
    const driver = new FakeFindDriver();
    driver.entries.set("/workspace/app.py", { size: 10, mtimeMs: 1_000 });
    const stubLens = async (input: {
      userId: string;
      runId: string;
      lens: string;
      runsDir?: string | null;
    }): Promise<RunAudit | null> => {
      const audit: RunAudit = {
        lens: "security",
        verdict: "warn",
        provider: "fake",
        model: "fake-1",
        costUsd: 0.001,
        latencyMs: 5,
        cached: false,
        text: "- [high] unsafe input handling — impact — fix",
        createdAt: Date.now(),
      };
      const dir = input.runsDir ?? runsDir;
      fs.mkdirSync(path.dirname(auditFilePath(dir!, input.runId)), { recursive: true });
      fs.writeFileSync(auditFilePath(dir!, input.runId), JSON.stringify(audit), "utf8");
      return audit;
    };
    const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
    const vm = new VmManager({ customDriver: driver });
    const reporter = new RunReporter({
      vm,
      bus,
      browser: null,
      runsDir: () => runsDir,
      lensRunner: stubLens,
    });
    const runId = "run_audit";
    await vm.ensure("alice");
    reporter.attach(runId, "alice", "implementer");
    bus.publish(runId, { type: "run.created", data: { prompt: "write code", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    // Give the start-of-run listing a tick, then change a file so the diff has
    // an artifact for the audit to chew on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    driver.entries.set("/workspace/app.py", { size: 99, mtimeMs: 2_500 });
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);

    const audit = await waitFor(() => readRunAudit(runId, runsDir));
    assert.ok(audit);
    assert.equal(audit.verdict, "warn");
    assert.equal(audit.lens, "security");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("reporter does not audit a role without a pinned lens", async () => {
  const runsDir = tmpDir();
  try {
    let called = false;
    const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
    const vm = new VmManager({ customDriver: new FakeFindDriver() });
    const reporter = new RunReporter({
      vm,
      bus,
      browser: null,
      runsDir: () => runsDir,
      lensRunner: async (): Promise<RunAudit | null> => {
        called = true;
        return null;
      },
    });
    const runId = "run_no_audit";
    reporter.attach(runId, "alice", "main"); // main has no pinned lens
    bus.publish(runId, { type: "run.created", data: { prompt: "hi", userId: "alice" } });
    bus.publish(runId, { type: "vm.ready", data: { ms: 1 } });
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);

    await waitFor(() => readRunReport(runId, runsDir));
    // Give a (hypothetical) audit a beat to fire; it must not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(called, false);
    assert.equal(readRunAudit(runId, runsDir), null);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
