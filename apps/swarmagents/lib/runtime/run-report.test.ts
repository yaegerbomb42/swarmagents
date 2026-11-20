import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SequencedEvent } from "../telemetry/bus";
import {
  MAX_REPLAY_SHOTS,
  assembleReport,
  buildReportSteps,
  captureDesktopScreenshot,
  deriveCouldNotDo,
  diffWorkspaceLists,
  parseFindListing,
  readRunReport,
  readShotBytes,
  sampleShotIndices,
  writeRunReport,
  writeShotFile,
} from "./run-report";
import type { ReportShotMeta } from "./run-report-types";
import type { VmManager } from "../vm/manager";
import { DESKTOP_DISPLAY } from "../vm/docker-driver";

function seq(overrides: Record<string, unknown>): SequencedEvent {
  return { runId: "run_1", seq: 1, ts: 1_000, ...overrides } as unknown as SequencedEvent;
}

const ORDERED_EVENTS: SequencedEvent[] = [
  seq({ type: "run.created", seq: 1, data: { prompt: "build it", userId: "alice" } }),
  seq({ type: "run.started", seq: 2, model: "claude-sonnet-5-5", provider: "anthropic" }),
  seq({ type: "assistant.text", seq: 3, text: "Let me look." }),
  seq({ type: "tool.call", seq: 4, name: "Bash", input: { command: "ls" }, id: "t1" }),
  seq({ type: "tool.result", seq: 5, id: "t1", ok: true, truncated: false, output: "a.txt" }),
  seq({ type: "computer.action", seq: 6, action: "Opening example.com" }),
  seq({ type: "assistant.text", seq: 7, text: "Done." }),
  seq({ type: "run.finished", seq: 8, exitCode: 0, sessionId: "s1", costUsd: 0.1, durationMs: 5000, numTurns: 2 }),
];

test("buildReportSteps condenses events into ordered, readable steps", () => {
  const steps = buildReportSteps(ORDERED_EVENTS);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.text]),
    [
      ["start", "Run started · claude-sonnet-5-5"],
      ["message", "Let me look."],
      ["tool", "Using Bash"],
      ["desktop", "Opening example.com"],
      ["message", "Done."],
      ["end", "Finished · exit 0"],
    ],
  );
  // The tool step pairs with its result (ok: true) via the call id.
  assert.equal(steps.find((step) => step.kind === "tool")?.ok, true);
  assert.equal(steps[0].seq, 2);
  assert.equal(steps[steps.length - 1].seq, 8);
});

test("buildReportSteps merges consecutive assistant text into one message step", () => {
  const events = [
    seq({ type: "assistant.text", seq: 1, text: "first" }),
    seq({ type: "assistant.text", seq: 2, text: "second", runId: "run_1" }),
  ];
  // Telemetry seqs are strictly increasing, so consecutive chunks of one
  // message can never share a seq: they merge on kind alone, concatenated
  // directly with no injected space (chunks carry their own spacing).
  const steps = buildReportSteps(events);
  assert.deepEqual(steps.map((step) => step.text), ["firstsecond"]);
});

test("buildReportSteps keeps messages from separate turns apart", () => {
  const events = [
    seq({ type: "assistant.text", seq: 1, text: "first" }),
    seq({ type: "assistant.text", seq: 2, text: "second" }),
    seq({ type: "tool.call", seq: 3, name: "Bash", id: "t1" }),
    seq({ type: "assistant.text", seq: 4, text: "third" }),
  ];
  const steps = buildReportSteps(events);
  assert.deepEqual(steps.map((step) => step.text), ["firstsecond", "Using Bash", "third"]);
});

test("buildReportSteps marks failed tool results on the paired step", () => {
  const events = [
    seq({ type: "tool.call", seq: 1, name: "Write", id: "t1" }),
    seq({ type: "tool.result", seq: 2, id: "t1", ok: false, truncated: false, output: "permission denied" }),
  ];
  const steps = buildReportSteps(events);
  assert.equal(steps[0].ok, false);
});

test("deriveCouldNotDo collects failed steps, blocks, denied approvals, and terminal errors", () => {
  const events: SequencedEvent[] = [
    seq({ type: "tool.call", seq: 1, name: "Bash", id: "t1" }),
    seq({ type: "tool.result", seq: 2, id: "t1", ok: false, truncated: false, output: "no such file" }),
    seq({ type: "tool.blocked", seq: 3, name: "Bash", reason: "destructive command" }),
    seq({
      type: "approval.resolved",
      seq: 4,
      id: "a1",
      verdict: "denied",
      data: { approval: { id: "a1", tool: "Bash", action: "rm -rf /" } },
    }),
    seq({ type: "run.error", seq: 5, message: "claude exited with code 1: boom" }),
    seq({ type: "tool.call", seq: 6, name: "Read", id: "t2" }),
    seq({ type: "tool.result", seq: 7, id: "t2", ok: true, truncated: false, output: "ok" }),
  ];
  const out = deriveCouldNotDo(events);
  assert.ok(out.some((line) => line.includes("Bash returned an error") && line.includes("no such file")));
  assert.ok(out.some((line) => line.includes("Bash was blocked: destructive command")));
  assert.ok(out.some((line) => line.includes("Approval for rm -rf / was denied")));
  assert.ok(out.some((line) => line.includes("claude exited with code 1: boom")));
  assert.ok(!out.some((line) => line.includes("Read returned an error")));
  assert.ok(!out.some((line) => line.includes("ok")));
});

test("parseFindListing parses NUL-separated find output", () => {
  const text = "/workspace/a.txt\x00123\x001508000000\x00/workspace/sub/b.png\x0020\x001700000000\x00";
  const listing = parseFindListing(text);
  assert.equal(listing.size, 2);
  assert.deepEqual(listing.get("/workspace/a.txt"), { size: 123, mtimeMs: 1_508_000_000_000 });
  assert.deepEqual(listing.get("/workspace/sub/b.png"), { size: 20, mtimeMs: 1_700_000_000_000 });
});

test("parseFindListing skips malformed rows", () => {
  const listing = parseFindListing("/workspace/a.txt\0oops\0");
  assert.equal(listing.size, 0);
});

test("diffWorkspaceLists reports created and modified files, sorted", () => {
  const before = new Map([
    ["/workspace/a.txt", { size: 10, mtimeMs: 100 }],
    ["/workspace/unchanged.txt", { size: 5, mtimeMs: 100 }],
  ]);
  const after = new Map([
    ["/workspace/a.txt", { size: 25, mtimeMs: 200 }], // modified
    ["/workspace/b.txt", { size: 7, mtimeMs: 150 }], // created
    ["/workspace/unchanged.txt", { size: 5, mtimeMs: 100 }], // unchanged
  ]);
  const artifacts = diffWorkspaceLists(before, after);
  assert.deepEqual(
    artifacts.map((artifact) => [artifact.rel, artifact.change]),
    [
      ["a.txt", "modified"],
      ["b.txt", "created"],
    ],
  );
  assert.equal(artifacts[0].size, 25);
  assert.equal(artifacts[0].mtimeMs, 200);
});

test("diffWorkspaceLists returns [] when there is no before snapshot", () => {
  assert.deepEqual(diffWorkspaceLists(null, new Map([["/workspace/a.txt", { size: 1, mtimeMs: 1 }]])), []);
});

test("sampleShotIndices spreads samples and keeps first/last", () => {
  assert.deepEqual(sampleShotIndices(5, 10), [0, 1, 2, 3, 4]);
  assert.deepEqual(sampleShotIndices(10, 4), [0, 3, 6, 9]);
  assert.deepEqual(sampleShotIndices(1, 30), [0]);
  assert.deepEqual(sampleShotIndices(0, 30), []);
});

test("captureDesktopScreenshot passes DISPLAY and removes the png on every path", async () => {
  const seen: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const vm = {
    exec: async (_userId: string, cmd: string[], opts?: Record<string, unknown>) => {
      seen.push({ cmd, opts: opts ?? {} });
      (opts?.onStdout as ((chunk: string) => void) | undefined)?.(png.toString("latin1"));
      return { exitCode: 0 };
    },
  } as unknown as VmManager;

  const shot = await captureDesktopScreenshot(vm, "alice");
  assert.ok(shot, "expected a captured shot");
  assert.equal(shot!.mime, "image/png");
  assert.equal(seen.length, 1);
  const call = seen[0]!;
  // DISPLAY must ride on env (not argv) so scrot finds the desktop.
  assert.deepEqual(
    (call.opts.env as Record<string, string> | undefined)?.DISPLAY,
    DESKTOP_DISPLAY,
  );
  assert.ok(!call.cmd.join(" ").includes(DESKTOP_DISPLAY), "DISPLAY value must not appear in argv");
  // The temp png is removed whether scrot/cat succeed or fail — no leak.
  const script = call.cmd.join(" ");
  assert.match(script, /rm -f "\$1"/);
  assert.match(script, /scrot -o "\$1"/);
  assert.match(script, /exit 1/);
});

test("captureDesktopScreenshot returns null when scrot fails", async () => {
  const vm = {
    exec: async () => ({ exitCode: 1 }),
  } as unknown as VmManager;
  assert.equal(await captureDesktopScreenshot(vm, "alice"), null);
});

test("assembleReport folds stats and derives summary fields", () => {
  const report = assembleReport({
    runId: "run_1",
    userId: "alice",
    events: ORDERED_EVENTS,
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [],
    shots: [],
    finalText: "Done.",
  });
  assert.equal(report.status, "finished");
  assert.deepEqual(report.meta.providers, ["anthropic"]);
  assert.equal(report.meta.model, "claude-sonnet-5-5");
  assert.equal(report.meta.costUsd, 0.1);
  assert.equal(report.meta.durationMs, 5000);
  assert.equal(report.finalText, "Done.");
  assert.equal(report.prompt, "build it");
  assert.ok(Array.isArray(report.steps) && report.steps.length > 0);
  assert.equal(report.meta.steps, report.steps.length);
});

test("assembleReport records the run's VM image in the report meta", () => {
  const withImage = assembleReport({
    runId: "run_1",
    userId: "alice",
    events: ORDERED_EVENTS,
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [],
    shots: [],
    vmImage: "swarm-vm:claude",
  });
  assert.equal(withImage.meta.vmImage, "swarm-vm:claude");

  // Drivers without an image (fake runs) and pre-existing reports leave
  // the field absent, never a guessed default.
  const withoutImage = assembleReport({
    runId: "run_1",
    userId: "alice",
    events: ORDERED_EVENTS,
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [],
    shots: [],
  });
  assert.equal(withoutImage.meta.vmImage, undefined);
  assert.ok(!("vmImage" in withoutImage.meta));
});

test("run report persists to disk and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-report-"));
  try {
    const report = assembleReport({
      runId: "run_1",
      userId: "alice",
      events: ORDERED_EVENTS,
      createdAt: 1_000,
      finishedAt: 6_000,
      artifacts: [],
      shots: [],
    });
    writeRunReport("run_1", report, dir);
    const read = readRunReport("run_1", dir);
    assert.ok(read);
    assert.equal(read!.runId, "run_1");
    assert.equal(read!.userId, "alice");
    assert.deepEqual(read!.meta.providers, ["anthropic"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunReport returns null for missing or foreign runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-report-"));
  try {
    assert.equal(readRunReport("run_missing", dir), null);
    const report = assembleReport({
      runId: "run_1",
      userId: "alice",
      events: ORDERED_EVENTS,
      createdAt: 1_000,
      finishedAt: 6_000,
      artifacts: [],
      shots: [],
    });
    writeRunReport("run_1", report, dir);
    // A mismatched runId inside the file is rejected.
    const foreign = JSON.parse(fs.readFileSync(path.join(dir, "reports", "run_1", "report.json"), "utf8")) as { runId: string };
    foreign.runId = "run_other";
    fs.writeFileSync(path.join(dir, "reports", "run_1", "report.json"), JSON.stringify(foreign));
    assert.equal(readRunReport("run_1", dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeShotFile + readShotBytes round-trip image bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-report-"));
  try {
    const shot: ReportShotMeta = {
      file: "000.png",
      mime: "image/png",
      seq: 0,
      ts: 1_000,
      label: "Start",
      size: 4,
    };
    writeShotFile("run_1", shot, Buffer.from([1, 2, 3, 4]), dir);
    // readShotBytes reads through the report document, so write a report first.
    const report = assembleReport({
      runId: "run_1",
      userId: "alice",
      events: ORDERED_EVENTS,
      createdAt: 1_000,
      finishedAt: 6_000,
      artifacts: [],
      shots: [shot],
    });
    writeRunReport("run_1", report, dir);
    const bytes = readShotBytes("run_1", 0, dir);
    assert.ok(bytes);
    assert.deepEqual([...bytes!.bytes], [1, 2, 3, 4]);
    assert.equal(bytes!.mime, "image/png");
    assert.equal(readShotBytes("run_1", 5, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
