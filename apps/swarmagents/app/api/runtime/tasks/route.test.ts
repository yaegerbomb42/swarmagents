/**
 * End-to-end tests for /api/runtime/tasks using the fake VM driver.
 *
 * A ScriptedFakeVm replays a recorded `claude --output-format stream-json`
 * transcript so the full wiring (route -> RuntimeManager -> ClaudeCodeRunner
 * -> FakeVmDriver -> TelemetryBus) is exercised without Docker. Auth is the
 * middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "./route";
import { createRouter } from "../../../../lib/providers";
import type { Router } from "../../../../lib/providers";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { getRemoteRunManager, resetRemoteRunManagerForTesting } from "../../../../lib/computers/remote";
import { configureComputersStoreDir, createPairingCode, redeemPairingCode } from "../../../../lib/computers/store";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import { telemetryBus } from "../../../../lib/telemetry/index";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../lib/vm/types";
import type { RunSummary } from "../../../../lib/runtime/manager";
import { configureSessionPaths, getLastSession, setLastSession } from "../../../../lib/runtime/session-store";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A minimal realistic stream-json transcript: init, one assistant text, result.
const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello from the vm" }] } }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_1", cost_usd: 0.01, duration_ms: 10, num_turns: 1 }),
];

/** One scripted claude invocation: which lines to replay and how it exits. */
interface ScriptedPlan {
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

class ScriptedFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];
  /** Index of the next claude invocation (plans/delays key off this). */
  private claudeCallIndex = 0;

  constructor(
    readonly fixtureLines: string[] = FIXTURE_LINES,
    private readonly delays: number[] = [],
    private readonly plans?: ScriptedPlan[],
  ) {
    super();
  }

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
    const aborted = () => {
      opts?.onStderr?.("aborted\n");
      return { exitCode: 130 };
    };
    if (cmd[0] !== "claude") {
      if (opts?.signal?.aborted) return aborted();
      return super.exec(h, cmd, opts);
    }

    // Consume one slot per claude invocation attempt — even one aborted before
    // it starts (the run was cancelled while booting) — so the next run never
    // inherits the previous run's scripted delay.
    const idx = this.claudeCallIndex++;
    if (opts?.signal?.aborted) return aborted();
    const plan = this.plans?.[idx];
    const delay = plan?.delayMs ?? this.delays[idx] ?? 0;
    if (delay > 0) {
      // Interruptible delay: an abort (e.g. cancel/new_thread) wakes the call
      // immediately instead of waiting out the full delay.
      const aborted = new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([sleep(delay), aborted]);
    }
    if (opts?.signal?.aborted) return aborted();
    if (plan?.stderr !== undefined) opts?.onStderr?.(plan.stderr);
    const lines = plan?.lines ?? this.fixtureLines;
    for (const line of lines) opts?.onStdout?.(`${line}\n`);
    return { exitCode: plan?.exitCode ?? 0 };
  }
}

class RecordingResetFake extends ScriptedFakeVm {
  resets = 0;
  override async reset(h: VmHandle): Promise<void> {
    this.resets += 1;
    await super.reset(h);
  }
}

class ErrorFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];
  constructor(
    private exitCode: number,
    private stderr: string,
  ) {
    super();
  }
  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
    if (cmd[0] === "claude") {
      if (this.stderr) opts?.onStderr?.(this.stderr);
      return { exitCode: this.exitCode };
    }
    return super.exec(h, cmd, opts);
  }
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

function postTask(body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(request("/api/runtime/tasks", { method: "POST", body: JSON.stringify(body) }, user));
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function listRuns(user = "alice"): Promise<RunSummary[]> {
  return (await json(await GET(request("/api/runtime/tasks", {}, user)))).runs;
}

/** Poll GET until `pred` holds for the run list (bounded, no busy spin). */
async function waitForRuns(pred: (runs: RunSummary[]) => boolean, steps = 400): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = await listRuns();
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

/** Poll until the driver recorded at least `count` exec calls (bounded). */
async function waitForCalls(driver: { calls: unknown[] }, count: number, steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} exec calls (have ${driver.calls.length})`);
}

/**
 * Agent-level exec calls only. The RunReporter also execs on the VM for its
 * background workspace listing (`find`) and desktop screenshot capture
 * (`sh -c scrot …`); agent-command assertions filter those out.
 */
function agentCalls(driver: { calls: Array<{ cmd: string[]; opts: ExecOptions }> }) {
  return driver.calls.filter((call) => call.cmd[0] !== "find" && call.cmd[0] !== "sh");
}

/** Poll until `count` agent-level exec calls were recorded (bounded). */
async function waitForAgentCalls(driver: { calls: Array<{ cmd: string[]; opts: ExecOptions }> }, count: number, steps = 400): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (agentCalls(driver).length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} agent exec calls (have ${agentCalls(driver).length})`);
}

function install(driver: VmDriver, router?: Router | null): RuntimeManager {
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router });
  setRuntimeManagerForTesting(manager);
  return manager;
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.SWARM_HARNESS_TOKEN;
});

test("POST starts a run, publishes telemetry, and GET lists it as finished", async () => {
  const router = createRouter({
    providers: [
      { id: "gw-a", kind: "anthropic", baseUrl: "http://gw", rank: 0, keys: ["sk-test-gw-key-0000"] },
    ],
  });
  const driver = new ScriptedFakeVm();
  install(driver, router);
  process.env.SWARM_HARNESS_TOKEN = "never-forward-this";

  const res = await postTask({ prompt: "  Build a thing  ", sessionId: "sess_resume_9" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  assert.match(runId, /^run_[A-Za-z0-9_-]{1,64}$/);

  const runs = await waitForRuns((r) => r.length > 0 && r[0].status !== "running");
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].status, "finished");
  assert.equal(runs[0].exitCode, 0);
  assert.equal(runs[0].sessionId, "sess_1"); // canonical session from the result event
  assert.equal(runs[0].costUsd, 0.01);
  assert.equal(runs[0].durationMs, 10);
  assert.equal(runs[0].numTurns, 1);
  assert.equal(runs[0].prompt, "Build a thing");
  assert.ok(typeof runs[0].createdAt === "number");
  assert.ok(typeof runs[0].finishedAt === "number");

  // One claude invocation; argv shape matches the harness contract (fixed
  // base flags, then the default Main Agent role phase: --allowedTools,
  // --mcp-config, --append-system-prompt, then `--` + prompt); the provider
  // token is chosen by lib/providers and rides in env, never argv.
  await waitForAgentCalls(driver, 1);
  const { cmd, opts } = agentCalls(driver)[0];
  assert.deepEqual(cmd.slice(0, 5), [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  const resumeIdx = cmd.indexOf("--resume");
  assert.ok(resumeIdx !== -1, "run should include --resume");
  assert.equal(cmd[resumeIdx + 1], "sess_resume_9");
  const allowedIdx = cmd.indexOf("--allowedTools");
  assert.ok(allowedIdx !== -1, "role phase should pass --allowedTools");
  const allowed = cmd.slice(allowedIdx + 1, cmd.indexOf("--mcp-config"));
  assert.ok(allowed.includes("Plan"));
  assert.ok(allowed.includes("Bash"));
  assert.ok(allowed.includes("mcp__roles__*"));
  assert.equal(cmd[cmd.indexOf("--mcp-config") + 1], "/workspace/.swarm/mcp.json");
  assert.ok(cmd.includes("--append-system-prompt"));
  assert.equal(cmd[cmd.indexOf("--") + 1], "Build a thing");
  assert.equal(cmd[cmd.length - 1], "Build a thing");
  assert.equal(opts.env?.ANTHROPIC_AUTH_TOKEN, "sk-test-gw-key-0000");
  assert.equal(opts.env?.ANTHROPIC_BASE_URL, "http://gw");
  assert.equal(opts.env?.ANTHROPIC_MODEL, "claude-sonnet-4-5");
  assert.equal(opts.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(opts.env?.SWARM_HARNESS_TOKEN, undefined); // internals never forwarded
  assert.ok(!cmd.some((a) => a.includes("sk-test-gw-key-0000")));

  // Events streamed on the bus for the runId.
  assert.ok(telemetryBus.latestSeq(runId) >= 4); // created, started, text, finished
});

test("POST forwards a requested model: GET lists it on the run", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);
  const res = await postTask({ prompt: "Build it", model: "clarke-1.0" });
  assert.equal(res.status, 201);
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].model, "clarke-1.0");
  // The requested model rides to the harness as --model.
  const cmd = agentCalls(driver)[0].cmd;
  const modelIdx = cmd.indexOf("--model");
  assert.ok(modelIdx !== -1, "requested model should be passed as --model");
  assert.equal(cmd[modelIdx + 1], "clarke-1.0");
});

for (const tier of ["deep", "balanced", "fast"] as const) {
  test(`POST with tier "${tier}" and no router never puts a tier alias in --model`, async () => {
    const driver = new ScriptedFakeVm();
    install(driver);
    const res = await postTask({ prompt: "Build it", tier });
    assert.equal(res.status, 201);
    await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
    const cmd = agentCalls(driver)[0].cmd;
    assert.equal(cmd.indexOf("--model"), -1, `host-env fallback must not run claude --model ${tier}`);
  });
}

test("POST rejects an unknown tier", async () => {
  install(new ScriptedFakeVm());
  const res = await postTask({ prompt: "Build it", tier: "turbo" });
  assert.equal(res.status, 400);
});

test("router-selected provider/model reach the task list with no requested model", async () => {
  const driver = new ScriptedFakeVm();
  const selection = {
    env: {},
    secrets: [],
    provider: "radium",
    keyId: "radium:key-1",
    model: "clarke-1.0",
    settle: () => {},
    release: () => {},
  };
  const router = { selectForClaude: () => selection } as unknown as Router;
  install(driver, router);

  const res = await postTask({ prompt: "Build it" });
  assert.equal(res.status, 201);
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].status, "finished");
  assert.equal(runs[0].provider, "radium");
  assert.equal(runs[0].model, "clarke-1.0");
  // The router's model rides to the harness as --model.
  const cmd = agentCalls(driver)[0].cmd;
  const modelIdx = cmd.indexOf("--model");
  assert.ok(modelIdx !== -1, "router model should be passed as --model");
  assert.equal(cmd[modelIdx + 1], "clarke-1.0");
});

test("agentCard rides along to the claude harness as the appended system prompt", async () => {
  const card = "I am your autonomous engineer on this Linux VM.\n- Ask approval before risky actions.";
  const driver = new ScriptedFakeVm();
  install(driver);
  const res = await postTask({ prompt: "Build the thing", agentCard: card });
  assert.equal(res.status, 201);
  await waitForRuns((r) => r.length === 1 && r[0].status !== "running");

  assert.equal(agentCalls(driver).length, 1);
  const { cmd, opts } = agentCalls(driver)[0];
  const idx = cmd.indexOf("--append-system-prompt");
  assert.ok(idx !== -1, "harness argv should carry --append-system-prompt");
  // The card leads the appended prompt; the active role's prompt (Main Agent
  // by default) follows after a blank line, all in one argv element.
  assert.ok(cmd[idx + 1].startsWith(card + "\n\n") || cmd[idx + 1] === card, "card text must lead its own argv element");
  assert.equal(cmd[cmd.length - 2], "--");
  assert.equal(cmd[cmd.length - 1], "Build the thing");
  // The card is system-prompt material, never env material.
  assert.ok(!Object.values(opts.env ?? {}).includes(card));
});

test("agentCard longer than 4000 chars is capped server-side", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);
  const long = "x".repeat(5000);
  const res = await postTask({ prompt: "p", agentCard: long });
  assert.equal(res.status, 201);
  await waitForRuns((r) => r.length === 1 && r[0].status !== "running");

  const { cmd } = agentCalls(driver)[0];
  const idx = cmd.indexOf("--append-system-prompt");
  assert.ok(idx !== -1);
  const appended = cmd[idx + 1];
  assert.ok(appended.startsWith(long.slice(0, 4000)));
  assert.ok(!appended.startsWith(long.slice(0, 4001)), "card is capped at 4000 chars");
});

test("queued runs keep their own agent card", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [150]); // first run is slow
  install(driver);

  const first = await json(await postTask({ prompt: "first", agentCard: "card one" }));
  const second = await json(await postTask({ prompt: "second", agentCard: "card two" }));
  assert.equal(second.queued, true);
  await waitForRuns((r) => r.length >= 2 && r.every((x) => x.status !== "running"));

  assert.equal(agentCalls(driver).length, 2);
  const firstCmd = agentCalls(driver)[0].cmd;
  const secondCmd = agentCalls(driver)[1].cmd;
  assert.ok(firstCmd[firstCmd.indexOf("--append-system-prompt") + 1].startsWith("card one"));
  assert.ok(secondCmd[secondCmd.indexOf("--append-system-prompt") + 1].startsWith("card two"));
});

test("rejects unauthenticated requests", async () => {
  install(new ScriptedFakeVm());
  assert.equal((await GET(request("/api/runtime/tasks", {}, null))).status, 401);
  assert.equal((await POST(request("/api/runtime/tasks", { method: "POST", body: "{}" }, null))).status, 401);
  assert.equal((await DELETE(request("/api/runtime/tasks?runId=run_x", {}, null))).status, 401);
});

test("rejects invalid bodies", async () => {
  install(new ScriptedFakeVm());
  assert.equal((await postTask("not json")).status, 400);
  assert.equal((await postTask([])).status, 400);
  assert.equal((await postTask({})).status, 400);
  assert.equal((await postTask({ prompt: "" })).status, 400);
  assert.equal((await postTask({ prompt: "   " })).status, 400);
  assert.equal((await postTask({ prompt: 42 })).status, 400);
  const big = { prompt: "x".repeat(300 * 1024) };
  assert.equal((await postTask(big)).status, 413);
});

test("one active run per user: a new POST queues behind the active run", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [150]); // first run is slow
  install(driver);

  const firstRes = await postTask({ prompt: "first" });
  assert.equal(firstRes.status, 201);
  const first = await json(firstRes);
  const secondRes = await postTask({ prompt: "second" });
  assert.equal(secondRes.status, 202);
  const second = await json(secondRes);
  assert.equal(second.queued, true);
  assert.equal(second.position, 1);
  assert.notEqual(first.runId, second.runId);

  const runs = await waitForRuns((r) => r.length >= 2 && r.every((x) => x.status !== "running"));

  const firstSummary = runs.find((r) => r.runId === first.runId);
  const secondSummary = runs.find((r) => r.runId === second.runId);
  assert.equal(firstSummary?.status, "finished");
  assert.equal(secondSummary?.status, "finished");
  assert.equal(agentCalls(driver).length, 2);
  assert.equal(agentCalls(driver)[0].cmd.at(-1), "first");
  assert.equal(agentCalls(driver)[1].cmd.at(-1), "second");
});

test("DELETE cancels the active run and frees the slot", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000]); // long-running
  install(driver);

  const { runId } = await json(await postTask({ prompt: "long task" }));
  const res = await DELETE(request(`/api/runtime/tasks?runId=${runId}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, runId });

  const runs = await waitForRuns((r) => r.length === 1 && r[0].status === "cancelled");
  assert.equal(runs[0].cancelledReason, "user");
  // A run.cancelled event is published on the bus alongside the terminal state.
  const subscribed: string[] = [];
  telemetryBus.subscribe(runId, 0, (e) => subscribed.push(e.type));
  assert.ok(subscribed.includes("run.cancelled"));

  // Cancelling again (or an unknown id) is a 404.
  assert.equal((await DELETE(request(`/api/runtime/tasks?runId=${runId}`))).status, 404);
  assert.equal((await DELETE(request("/api/runtime/tasks?runId=run_ghost"))).status, 404);
});

test("DELETE without runId cancels the active run", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000]);
  install(driver);
  await postTask({ prompt: "x" });
  assert.equal((await DELETE(request("/api/runtime/tasks"))).status, 200);
  await waitForRuns((r) => r.length === 1 && r[0].status === "cancelled");
  assert.equal((await DELETE(request("/api/runtime/tasks"))).status, 404);
});

test("DELETE without runId requires runId when both a cloud run and a paired-computer run are active", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-route-remote-")));
  configureComputersStoreDir(dir);
  try {
    const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000]);
    install(driver);
    await postTask({ prompt: "cloud run" });
    await waitForAgentCalls(driver, 1); // the cloud run is active

    const pairing = createPairingCode("alice");
    const redeemed = redeemPairingCode(pairing.code, { name: "Build box", os: "linux", mode: "host" });
    assert.ok(redeemed, "computer pairing should redeem");
    const started = getRemoteRunManager().start("alice", {
      prompt: "computer run",
      computerId: redeemed.computer.id,
    });
    assert.equal(started.accepted, true);
    assert.equal(getRemoteRunManager().list("alice").length, 1, "paired-computer run should be live");

    // Both runtimes are live and no runId was given -> require one.
    const both = await DELETE(request("/api/runtime/tasks"));
    assert.equal(both.status, 400);
    assert.match((await json(both)).error, /runId/);

    // With an explicit runId the paired-computer run still cancels cleanly.
    const remoteRes = await DELETE(request(`/api/runtime/tasks?runId=${started.runId}`));
    assert.equal(remoteRes.status, 200);
    assert.equal((await json(remoteRes)).runId, started.runId);
  } finally {
    resetRemoteRunManagerForTesting();
    configureComputersStoreDir("");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("DELETE on a queued run (stop-queued) cancels only it; the active run and queue order survive", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000, 5000, 5000]);
  install(driver);

  await postTask({ prompt: "active" });
  const second = await json(await postTask({ prompt: "queued-2" }));
  const third = await json(await postTask({ prompt: "queued-3" }));
  assert.equal(second.queued, true);
  assert.equal(third.queued, true);
  assert.equal(third.position, 2);

  const res = await DELETE(request(`/api/runtime/tasks?runId=${second.runId}`));
  assert.equal(res.status, 200);

  await waitForRuns(
    (r) => r.some((x) => x.runId === second.runId && x.status === "cancelled"),
    1000,
  );
  await waitForAgentCalls(driver, 2, 1000);
  await waitForRuns(
    (r) => r.some((x) => x.runId === third.runId && x.status === "finished"),
    1000,
  );
  assert.equal(agentCalls(driver).length, 2); // active + third; the cancelled second never ran
});

test("DELETE on the active run (stop-running) cancels it and starts the next queued prompt at once", async () => {
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000, 5000, 5000]);
  install(driver);

  const first = await json(await postTask({ prompt: "long task" }));
  const second = await json(await postTask({ prompt: "queued after stop" }));
  assert.equal(second.queued, true);
  await waitForAgentCalls(driver, 1);

  const res = await DELETE(request(`/api/runtime/tasks?runId=${first.runId}`));
  assert.equal(res.status, 200);

  // The queued prompt occupies the freed slot immediately (no 70s wedge).
  const runs = await waitForRuns(
    (r) =>
      r.find((x) => x.runId === first.runId)?.status === "cancelled" &&
      r.find((x) => x.runId === second.runId)?.status === "finished",
    1000,
  );
  assert.equal(runs.find((r) => r.runId === first.runId)?.status, "cancelled");
  assert.equal(runs.find((r) => r.runId === second.runId)?.status, "finished");
  assert.equal(agentCalls(driver).length, 2);
});

test("POST wipe_vm resets the VM and cancels any active run", async () => {
  const driver = new RecordingResetFake(FIXTURE_LINES, [5000]);
  install(driver);

  const { runId } = await json(await postTask({ prompt: "before wipe" }));
  const res = await postTask({ action: "wipe_vm" });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, status: "reset" });
  assert.equal(driver.resets, 1);

  const runs = await waitForRuns((r) => r.length === 1 && r[0].status === "cancelled");
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].cancelledReason, "user");
});

test("POST new_thread cancels the active run and clears the persisted session", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-route-thread-")));
  configureSessionPaths(path.join(dir, "sessions.json"));

  try {
    await setLastSession("alice", "sess_old");
    const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000]);
    install(driver);

    await json(await postTask({ prompt: "old thread" }));
    const res = await postTask({ action: "new_thread" });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true, status: "new_thread" });

    await waitForRuns((r) => r.length === 1 && r[0].status === "cancelled");
    assert.equal(getLastSession("alice"), undefined);

    const { runId } = await json(await postTask({ prompt: "fresh thread" }));
    assert.ok(runId);
    await waitForRuns((r) => r.length === 2 && r.every((x) => x.status !== "running"));
    assert.equal(agentCalls(driver)[1].cmd.includes("--resume"), false);
  } finally {
    configureSessionPaths("");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("auto-resume: successful run persists sessionId and next run reuses it", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-route-session-")));
  configureSessionPaths(path.join(dir, "sessions.json"));

  try {
    const driver = new ScriptedFakeVm();
    install(driver);

    // First run without explicit sessionId: should not pass --resume
    const first = await json(await postTask({ prompt: "first" }));
    await waitForAgentCalls(driver, 1);
    assert.equal(agentCalls(driver)[0].cmd.includes("--resume"), false);

    await waitForRuns((r) => r.length === 1 && r[0].status !== "running");

    // Wait for the async session store write to land
    for (let i = 0; i < 50; i++) {
      if (getLastSession("alice") === "sess_1") break;
      await sleep(20);
    }
    assert.equal(getLastSession("alice"), "sess_1");

    // Second run without explicit sessionId: should use persisted session
    const second = await json(await postTask({ prompt: "second" }));
    await waitForRuns((r) => r.length === 2 && r.every((x) => x.status !== "running"));

    await waitForAgentCalls(driver, 2);
    const secondCmd = agentCalls(driver)[1].cmd;
    const resumeIdx = secondCmd.indexOf("--resume");
    assert.ok(resumeIdx !== -1, "second run should include --resume");
    assert.equal(secondCmd[resumeIdx + 1], "sess_1");
  } finally {
    configureSessionPaths("");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("unknown session error clears the persisted session", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-route-session-")));
  configureSessionPaths(path.join(dir, "sessions.json"));

  try {
    await setLastSession("alice", "sess_bad");
    assert.equal(getLastSession("alice"), "sess_bad");

    const driver = new ErrorFakeVm(1, "Error: unknown session: sess_bad");
    install(driver);

    const { runId } = await json(await postTask({ prompt: "should fail" }));
    await waitForRuns((r) => r.length === 1 && r[0].status !== "running");

    // The run should have attempted to resume the bad session
    await waitForAgentCalls(driver, 1);
    const cmd = agentCalls(driver)[0].cmd;
    const resumeIdx = cmd.indexOf("--resume");
    assert.ok(resumeIdx !== -1, "run should include --resume");
    assert.equal(cmd[resumeIdx + 1], "sess_bad");

    // The error should have cleared the persisted session
    for (let i = 0; i < 50; i++) {
      if (getLastSession("alice") === undefined) break;
      await sleep(20);
    }
    assert.equal(getLastSession("alice"), undefined);

    const runs = await listRuns();
    assert.equal(runs[0].runId, runId);
    assert.equal(runs[0].status, "error");
    assert.ok(runs[0].error?.toLowerCase().includes("unknown session"));
  } finally {
    configureSessionPaths("");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("non-unknown-session errors keep the persisted session", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-route-session-")));
  configureSessionPaths(path.join(dir, "sessions.json"));

  try {
    await setLastSession("alice", "sess_keep");
    assert.equal(getLastSession("alice"), "sess_keep");

    const driver = new ErrorFakeVm(1, "Error: permission denied");
    install(driver);

    await json(await postTask({ prompt: "should fail differently" }));
    await waitForRuns((r) => r.length === 1 && r[0].status !== "running");

    // The persisted session should remain because the error is not about unknown session
    for (let i = 0; i < 50; i++) {
      if (getLastSession("alice") !== undefined) break;
      await sleep(20);
    }
    assert.equal(getLastSession("alice"), "sess_keep");
  } finally {
    configureSessionPaths("");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("buildRunnerEnv forwards only Claude/Anthropic variables into the VM", async () => {
  const { buildRunnerEnv } = await import("../../../../lib/runtime/manager");
  const env = buildRunnerEnv({
    ANTHROPIC_BASE_URL: "http://gw",
    ANTHROPIC_AUTH_TOKEN: "t",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1000",
    GITHUB_TOKEN: "nope",
    SWARM_SESSION_SECRET: "nope",
    PATH: "/usr/bin",
    SWARM_VM_ENV_ALLOW: "TZ",
    TZ: "UTC",
  } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "TZ"]);
});

// --- Multi-provider pool -> Claude Code failover ---

const MERCURY_KEY = "sk_mercury_fake_key_0000";
const RADIUM_KEY = "sk_radium_fake_key_0000";

const ERROR_429_LINE = JSON.stringify({ type: "error", message: "Error: HTTP 429, provider overloaded" });
const ERROR_401_LINE = JSON.stringify({ type: "error", message: "Error: 401 unauthorized" });
const ERROR_OTHER_LINE = JSON.stringify({ type: "error", message: "Error: ENOENT" });
const FAILURE_FIXTURE = [ERROR_429_LINE];

function failoverRouter(): Router {
  return createRouter({
    providers: [
      { id: "mercury", kind: "openai", baseUrl: "https://api.inceptionlabs.ai/v1", keys: [MERCURY_KEY], rank: 0 },
      { id: "radium", kind: "anthropic", baseUrl: "https://radium.example.com/v1", keys: [RADIUM_KEY], rank: 1 },
    ],
  });
}

test("provider pool: 429 on the first provider fails over to the next, then finishes", async () => {
  const driver = new ScriptedFakeVm(FAILURE_FIXTURE, [], [
    { lines: FAILURE_FIXTURE, exitCode: 1 },
    { lines: FIXTURE_LINES, exitCode: 0 },
  ]);
  install(driver, failoverRouter());

  const res = await postTask({ prompt: "build me a report" });
  assert.equal(res.status, 201);
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].status, "finished");
  assert.equal(runs[0].exitCode, 0);

  // Two claude invocations: one per provider, in rank order.
  const agentCallsArr = agentCalls(driver);
  assert.equal(agentCallsArr.length, 2);
  const [first, second] = agentCallsArr;
  assert.equal(first.opts.env?.ANTHROPIC_AUTH_TOKEN, MERCURY_KEY);
  assert.equal(first.opts.env?.ANTHROPIC_BASE_URL, "https://api.inceptionlabs.ai/v1");
  assert.equal(second.opts.env?.ANTHROPIC_AUTH_TOKEN, RADIUM_KEY);
  assert.equal(second.opts.env?.ANTHROPIC_BASE_URL, "https://radium.example.com/v1");

  // Secrets ride in env, never argv; and never leak into events.
  for (const call of agentCallsArr) {
    assert.ok(!call.cmd.some((arg) => arg.includes(MERCURY_KEY) || arg.includes(RADIUM_KEY)));
  }
  const subscribed: string[] = [];
  telemetryBus.subscribe(runs[0].runId, 0, (e) => subscribed.push(e.type));
  assert.ok(subscribed.includes("run.failover"));
  assert.ok(subscribed.filter((t) => t === "run.error").length === 0, "provider failure should not surface as a run error");
});

test("provider pool: all providers fail with auth/overload -> run error with summary", async () => {
  const driver = new ScriptedFakeVm(FAILURE_FIXTURE, [], [
    { lines: [ERROR_401_LINE], exitCode: 1 },
    { lines: [ERROR_429_LINE], exitCode: 1 },
  ]);
  install(driver, failoverRouter());

  const { runId } = await json(await postTask({ prompt: "x" }));
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].status, "error");
  assert.equal(agentCalls(driver).length, 2);
  const subscribed: string[] = [];
  telemetryBus.subscribe(runId, 0, (e) => subscribed.push(e.type));
  assert.equal(subscribed.filter((t) => t === "run.failover").length, 2); // one per exhausted provider
  assert.equal(subscribed.filter((t) => t === "run.error").length, 1);
  assert.match(runs[0].error ?? "", /mercury/);
  assert.match(runs[0].error ?? "", /radium/);
});

test("provider pool: non-eligible failure is not retried on another provider", async () => {
  const driver = new ScriptedFakeVm(FAILURE_FIXTURE, [], [
    { lines: [ERROR_OTHER_LINE], stderr: "claude exited with code 1", exitCode: 1 },
  ]);
  install(driver, failoverRouter());

  await postTask({ prompt: "x" });
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].status, "error");
  assert.equal(agentCalls(driver).length, 1);
});

test("without pool keys, host ANTHROPIC_* env is forwarded untouched (legacy fallback)", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);
  process.env.ANTHROPIC_BASE_URL = "https://gw.example.com/v1";
  process.env.ANTHROPIC_AUTH_TOKEN = "host-auth-token";

  await postTask({ prompt: "x" });
  const runs = await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  assert.equal(runs[0].status, "finished");
  assert.equal(agentCalls(driver).length, 1);
  assert.equal(agentCalls(driver)[0].opts.env?.ANTHROPIC_BASE_URL, "https://gw.example.com/v1");
  assert.equal(agentCalls(driver)[0].opts.env?.ANTHROPIC_AUTH_TOKEN, "host-auth-token");
});

test("POST with roleId 'researcher' applies researcher role constraints (no Bash/Write/Edit)", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const res = await postTask({ prompt: "find the docs", roleId: "researcher" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);

  const runs = await waitForRuns((r) => r.length > 0 && r[0].status !== "running");
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].status, "finished");

  await waitForAgentCalls(driver, 1);
  const { cmd } = agentCalls(driver)[0];

  const allowedIdx = cmd.indexOf("--allowedTools");
  assert.ok(allowedIdx !== -1, "role phase should pass --allowedTools");
  const allowed = cmd.slice(allowedIdx + 1, cmd.indexOf("--mcp-config"));

  // Researcher has Read, Grep, WebSearch, WebFetch, Browser, etc., but NO Bash, Write, Edit
  assert.ok(allowed.includes("Read"));
  assert.ok(!allowed.includes("Bash"), "researcher must not have Bash tool");
  assert.ok(!allowed.includes("Write"), "researcher must not have Write tool");
  assert.ok(!allowed.includes("Edit"), "researcher must not have Edit tool");
});

test("POST with unknown roleId returns 400", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const res = await postTask({ prompt: "do something", roleId: "nonexistent_role_123" });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.match(body.error ?? "", /Unknown role "nonexistent_role_123"/);
});

test("POST with maxTurns passes --max-turns to claude; invalid maxTurns is rejected", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);
  const res = await postTask({ prompt: "Build it", maxTurns: 25 });
  assert.equal(res.status, 201);
  await waitForRuns((r) => r.length === 1 && r[0].status !== "running");
  await waitForAgentCalls(driver, 1);
  const { cmd } = agentCalls(driver)[0];
  const i = cmd.indexOf("--max-turns");
  assert.notEqual(i, -1, "run should include --max-turns");
  assert.equal(cmd[i + 1], "25");

  const bad = await postTask({ prompt: "Build it", maxTurns: 0 });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error ?? "", /maxTurns/);
});

test("POST steer supersedes the active run and resumes its session", async () => {
  // Both claude calls delayed so the steered run is still running when the
  // run list is asserted (the second call is the steered run itself).
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000, 5000]);
  install(driver);

  const first = await json(await postTask({ prompt: "build it in node", sessionId: "sess_route_1" }));
  const runA = first.runId;
  assert.ok(runA);
  await waitForAgentCalls(driver, 1);

  const res = await postTask({ action: "steer", prompt: "stop, use python instead" });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.ok(body.runId);
  assert.notEqual(body.runId, runA);
  assert.equal(body.steeredFrom, runA);
  assert.equal(body.queued, false);

  const runs = await waitForRuns((r) => r.length === 2 && r.every((x) => x.status !== "running" || x.runId === body.runId));
  const oldRun = runs.find((r) => r.runId === runA);
  assert.equal(oldRun?.status, "cancelled");
  assert.equal(oldRun?.cancelledReason, "superseded");
  const newRun = runs.find((r) => r.runId === body.runId);
  assert.equal(newRun?.status, "running");
  assert.equal(newRun?.prompt, "User interrupted: stop, use python instead");
  assert.equal(newRun?.sessionId, "sess_route_1");
  assert.equal(newRun?.steeredFrom, runA);

  await waitForAgentCalls(driver, 2);
  const secondCmd = agentCalls(driver)[1].cmd;
  const resumeIdx = secondCmd.indexOf("--resume");
  assert.ok(resumeIdx !== -1, "steered run should include --resume");
  assert.equal(secondCmd[resumeIdx + 1], "sess_route_1");
  assert.equal(secondCmd[secondCmd.indexOf("--") + 1], "User interrupted: stop, use python instead");
});

test("POST steer with no active run returns 409; empty prompt returns 400", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const none = await postTask({ action: "steer", prompt: "do something else" });
  assert.equal(none.status, 409);
  assert.match((await json(none)).error ?? "", /No active run/);

  const { runId } = await json(await postTask({ prompt: "work" }));
  assert.ok(runId);
  const empty = await postTask({ action: "steer", prompt: "   " });
  assert.equal(empty.status, 400);
  assert.match((await json(empty)).error ?? "", /prompt is required/);
});

test("POST steer leaves queued prompts queued behind the steered run", async () => {
  // Both claude calls delayed so the steered run is still running when the
  // queue state is asserted (the second call is the steered run itself).
  const driver = new ScriptedFakeVm(FIXTURE_LINES, [5000, 5000]);
  install(driver);

  const first = await json(await postTask({ prompt: "first work", sessionId: "sess_route_1" }));
  await waitForAgentCalls(driver, 1);
  const queued = await json(await postTask({ prompt: "queued follow-up" }));
  assert.equal(queued.queued, true);

  const steered = await json(await postTask({ action: "steer", prompt: "change of plan" }));
  assert.equal(steered.queued, false);

  const runs = await waitForRuns(
    (r) =>
      r.find((x) => x.runId === steered.runId)?.status === "running" &&
      r.find((x) => x.runId === queued.runId)?.status === "queued",
  );
  assert.equal(runs.find((r) => r.runId === steered.runId)?.status, "running");
  const stillQueued = runs.find((r) => r.runId === queued.runId);
  assert.equal(stillQueued?.status, "queued");
  assert.equal(stillQueued?.position, 1);
  assert.equal(runs.find((r) => r.runId === first.runId)?.status, "cancelled");
});
