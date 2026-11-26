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
  deriveArtifactsFromEvents,
  deriveCouldNotDo,
  diffWorkspaceLists,
  mergeArtifacts,
  parseFindListing,
  readRunReport,
  readShotBytes,
  sampleShotIndices,
  stripMarkdown,
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

test("stripMarkdown removes paired markers but leaves literal globs alone", () => {
  assert.equal(stripMarkdown("**Created:** `hello.txt` in your workspace"), "Created: hello.txt in your workspace");
  assert.equal(stripMarkdown("See [the docs](https://example.com) for __details__"), "See the docs for details");
  assert.equal(stripMarkdown("Finding **/*.ts files"), "Finding **/*.ts files");
});

test("buildReportSteps strips markdown from assistant text in the timeline", () => {
  const events = [
    seq({ type: "assistant.text", seq: 1, text: "**Created:** `hello.txt` in your workspace directory **Content:** `Hello from SwarmAgents`" }),
  ];
  const steps = buildReportSteps(events);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "message");
  assert.equal(steps[0].text, "Created: hello.txt in your workspace directory Content: Hello from SwarmAgents");
  assert.ok(!steps[0].text.includes("**"), "no raw bold markers in the timeline");
  assert.ok(!steps[0].text.includes("`"), "no raw code markers in the timeline");
});

test("deriveArtifactsFromEvents counts files the run's Write/Edit calls wrote", () => {
  const events = [
    seq({ type: "tool.call", seq: 1, name: "Write", id: "t1", input: { file_path: "/workspace/hello.txt" } }),
    seq({ type: "tool.result", seq: 2, id: "t1", ok: true }),
    seq({ type: "tool.call", seq: 3, name: "Edit", id: "t2", input: { file_path: "/workspace/app.py" } }),
    seq({ type: "tool.result", seq: 4, id: "t2", ok: true }),
    // A failed Write does not count, even though the file exists at run end.
    seq({ type: "tool.call", seq: 5, name: "Write", id: "t3", input: { file_path: "/workspace/broken.txt" } }),
    seq({ type: "tool.result", seq: 6, id: "t3", ok: false, output: "denied" }),
    // A Bash call is not a file write; a Write whose file is gone at run end
    // (reverted or deleted) does not count either.
    seq({ type: "tool.call", seq: 7, name: "Bash", id: "t4", input: { command: "ls" } }),
    seq({ type: "tool.result", seq: 8, id: "t4", ok: true }),
    seq({ type: "tool.call", seq: 9, name: "Write", id: "t5", input: { file_path: "/workspace/gone.txt" } }),
    seq({ type: "tool.result", seq: 10, id: "t5", ok: true }),
  ];
  const after = new Map([
    ["/workspace/hello.txt", { size: 23, mtimeMs: 2_000 }],
    ["/workspace/app.py", { size: 113, mtimeMs: 2_100 }],
    ["/workspace/broken.txt", { size: 5, mtimeMs: 2_200 }],
  ]);
  const before = new Map([["/workspace/app.py", { size: 10, mtimeMs: 1_000 }]]);
  const artifacts = deriveArtifactsFromEvents(events, after, before);
  assert.deepEqual(
    artifacts.map((a) => [a.rel, a.change, a.size]),
    [
      ["app.py", "modified", 113],
      ["hello.txt", "created", 23],
    ],
  );
});

test("deriveArtifactsFromEvents counts an unpaired Write when the file exists at run end", () => {
  const events = [
    seq({ type: "tool.call", seq: 1, name: "Write", id: "t1", input: { file_path: "/workspace/hello.txt" } }),
  ];
  const after = new Map([["/workspace/hello.txt", { size: 23, mtimeMs: 2_000 }]]);
  const artifacts = deriveArtifactsFromEvents(events, after, null);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].rel, "hello.txt");
  assert.equal(artifacts[0].change, "created");
});

test("mergeArtifacts unions the diff and the telemetry, preferring the diff", () => {
  const diff = [{ path: "/workspace/a.txt", rel: "a.txt", size: 25, mtimeMs: 200, change: "modified" as const }];
  const tool = [
    { path: "/workspace/a.txt", rel: "a.txt", size: 25, mtimeMs: 200, change: "created" as const },
    { path: "/workspace/b.txt", rel: "b.txt", size: 7, mtimeMs: 150, change: "created" as const },
  ];
  const merged = mergeArtifacts(diff, tool);
  assert.deepEqual(
    merged.map((a) => [a.rel, a.change]),
    [
      ["a.txt", "modified"],
      ["b.txt", "created"],
    ],
  );
});

test("assembleReport prefers the run's wall-clock duration over the CLI's inner duration", () => {
  // The CLI's result event says 3.1s (its own elapsed); the run itself took
  // 7s wall-clock (createdAt 1000 -> finishedAt 8000). The report must match
  // the run's displayed "Finished 7s", not the CLI's 3.1s.
  const events = [
    seq({ type: "run.created", seq: 1, data: { prompt: "build it", userId: "alice" } }),
    seq({ type: "run.finished", seq: 2, exitCode: 0, costUsd: 0.1, durationMs: 3100, numTurns: 2 }),
  ];
  const report = assembleReport({
    runId: "run_1",
    userId: "alice",
    events,
    createdAt: 1_000,
    finishedAt: 8_000,
    artifacts: [],
    shots: [],
  });
  assert.equal(report.meta.durationMs, 7000);
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

test("assembleReport carries the agent's final plan and its progress", () => {
  const steps = (statuses: string[]) =>
    statuses.map((status, i) => ({ id: String(i + 1), content: `step ${i + 1}`, status }));
  const events = [
    seq({ type: "run.created", seq: 1, data: { prompt: "do it", userId: "alice" } }),
    seq({ type: "run.plan", seq: 2, steps: steps(["in_progress", "pending", "pending"]) }),
    seq({ type: "run.plan", seq: 3, steps: steps(["completed", "completed", "completed"]) }),
    seq({ type: "run.finished", seq: 4, exitCode: 0 }),
  ] as SequencedEvent[];
  const report = assembleReport({ runId: "run_p", userId: "alice", events, createdAt: 0, finishedAt: 10, artifacts: [], shots: [] });
  assert.deepEqual(report.meta.plan, { done: 3, total: 3 });
  assert.equal(report.plan?.length, 3);

  // A run that never planned carries no plan at all (nothing new on the card).
  const plain = assembleReport({
    runId: "run_q",
    userId: "alice",
    events: [seq({ type: "run.finished", seq: 1, exitCode: 0 })],
    createdAt: 0,
    finishedAt: 10,
    artifacts: [],
    shots: [],
  });
  assert.equal(plain.meta.plan, undefined);
  assert.equal(plain.plan, undefined);
});
