// LiveProviderExecutor against a fake `claude` binary: a node script that
// behaves like `claude -p --output-format stream-json` (it edits the
// workspace and prints stream-json with usage). Covers a pass, a wrong
// answer, a timeout (killed with its process group), a non-zero exit, and
// that the provider key never reaches the report or the logs.

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveProviderExecutor, LocalProcessExec, buildLiveEnv, foldLiveTelemetry } from "./live-executor";
import { ProviderEvalRunner } from "./provider-runner";
import { LocalTempIsolation } from "./runner";
import { PROVIDER_EVAL_TASKS } from "./provider-tasks";
import { xtermApp } from "./provider-tasks-desktop";
import { missingDesktopBinaries } from "./desktop-session";
import { existsSync } from "node:fs";
import { renderProviderMarkdownTable } from "./provider-report";

const KEY = "sk-live-eval-test-key-9f8e7d6c5b4a";
const TASK = PROVIDER_EVAL_TASKS.find((t) => t.id === "coding-fix-rate-limiter")!;

/**
 * The fake CLI. Its behaviour is picked by --model:
 *   fake-pass  writes the task's solution, 3 turns
 *   fake-wrong writes a wrong file, 2 turns
 *   fake-sleep starts a child that sleeps forever, then sleeps itself
 *   fake-crash prints an error and exits 3
 * It also echoes the key it was given in an assistant message, so the test
 * can prove the runner's redactor scrubs it.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const model = argv[argv.indexOf("--model") + 1];
const solution = JSON.parse(fs.readFileSync(path.join(__dirname, "solution.json"), "utf8"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0 });
fs.writeFileSync(path.join(__dirname, "last-env.json"), JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME,
  hasToken: process.env.ANTHROPIC_AUTH_TOKEN === ${JSON.stringify(KEY)},
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  configDir: process.env.CLAUDE_CONFIG_DIR,
  settings: fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || "/nonexistent", "settings.json")),
  leakedHostVar: process.env.SWARM_EVAL_HOST_SECRET !== undefined,
  maxTurns: argv[argv.indexOf("--max-turns") + 1],
}));
// Desktop runs: record the wiring and prove the task's windows are up.
const mcpAt = argv.indexOf("--mcp-config");
if (mcpAt >= 0) {
  const mcp = JSON.parse(fs.readFileSync(argv[mcpAt + 1], "utf8"));
  const display = mcp.mcpServers["computer-mcp"].env.DISPLAY;
  fs.writeFileSync(path.join(__dirname, "last-desktop.json"), JSON.stringify({
    mcp,
    allowedTools: argv[argv.indexOf("--allowedTools") + 1],
    settings: JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")),
    betaWindow: spawnSync("xdotool", ["search", "--name", "^beta$"], { env: { ...process.env, DISPLAY: display } }).status === 0,
  }));
  out({ type: "assistant", message: { id: "d1", model, content: [{ type: "tool_use", id: "c1", name: "mcp__computer-mcp__click", input: { x: 5, y: 5 } }], usage: usage(10, 1) } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Clicked\neffect: NO visible change after 1.0s; focused window unchanged" }] } });
}
out({ type: "system", subtype: "init", session_id: "s1", model });
out({ type: "assistant", message: { id: "m1", model, content: [{ type: "text", text: "My key is " + (process.env.ANTHROPIC_AUTH_TOKEN || "") }], usage: usage(1000, 50) } });
if (model === "fake-crash") { process.stderr.write("boom: provider said no\n"); process.exit(3); }
if (model === "fake-sleep") {
  const child = spawn("sleep", ["1000"], { stdio: "ignore" });
  fs.writeFileSync(path.join(__dirname, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
  return;
}
// Two content blocks of one message repeat its usage: counted once.
out({ type: "assistant", message: { id: "m2", model, content: [{ type: "text", text: "Fixing." }], usage: usage(1500, 80) } });
out({ type: "assistant", message: { id: "m2", model, content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "x" } }], usage: usage(1500, 80) } });
if (model === "fake-pass") {
  for (const [rel, content] of Object.entries(solution)) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), rel), content);
  }
} else {
  fs.writeFileSync(path.join(process.cwd(), "src/rateLimiter.js"), "module.exports = {};\n");
}
const turns = model === "fake-pass" ? 3 : 2;
if (model === "fake-pass") out({ type: "assistant", message: { id: "m3", model, content: [{ type: "text", text: "Done." }], usage: usage(2000, 40) } });
if (model === "fake-maxturns") { out({ type: "result", subtype: "error_max_turns", session_id: "s1", num_turns: 12, usage: usage(9000, 300) }); process.exit(1); }
const final = { type: "result", subtype: "success", session_id: "s1", num_turns: turns, duration_ms: 10, total_cost_usd: 0, result: "Done." };
// The real CLI puts cumulative usage on the result line.
if (model === "fake-pass") final.usage = { input_tokens: 400, output_tokens: 170, cache_read_input_tokens: 4100, cache_creation_input_tokens: 0 };
out(final);
`;

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-live-exec-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "claude");
  await writeFile(bin, FAKE_CLAUDE.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  await chmod(bin, 0o755);
  await writeFile(path.join(dir, "solution.json"), JSON.stringify(TASK.solution.files));
  const isoRoot = path.join(dir, "iso");
  await mkdir(isoRoot);
  return { dir, bin, isoRoot, logDir: path.join(dir, "logs") };
}

function executor(bin: string, logDir: string, extra: { timeoutMs?: number } = {}) {
  return new LiveProviderExecutor({
    provider: { kind: "anthropic", baseUrl: "http://127.0.0.1:9/gateway", keyEnv: "LIVE_EVAL_KEY" },
    claudeBin: bin,
    maxTurns: 12,
    logDir,
    env: { ...process.env, LIVE_EVAL_KEY: KEY, SWARM_EVAL_HOST_SECRET: "do-not-pass" },
    ...extra,
  });
}

test("a run that writes the solution passes, with turns, tokens and seconds recorded", async (t) => {
  const { dir, bin, isoRoot, logDir } = await setup(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(isoRoot), executor: executor(bin, logDir), mode: "live" });
  const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-pass" }], { tasks: [TASK] });
  assert.equal(trial.resolved, true, JSON.stringify(trial));
  assert.equal(trial.mode, "live");
  assert.equal(trial.exitReason, "completed");
  assert.equal(trial.metrics.totalTurns, 3);
  // The result line's cumulative usage wins (uncached + cache reads).
  assert.equal(trial.metrics.totalInputTokens, 400 + 4100);
  assert.equal(trial.metrics.totalOutputTokens, 170);
  assert.ok(trial.metrics.wallClockMs > 0);

  const seen = JSON.parse(await readFile(path.join(dir, "last-env.json"), "utf8"));
  assert.equal(seen.hasToken, true, "the key reaches the CLI through env");
  assert.equal(seen.baseUrl, "http://127.0.0.1:9/gateway");
  assert.equal(seen.settings, true, "headless permissions live in a throwaway config dir");
  assert.equal(seen.leakedHostVar, false, "unrelated host env is not inherited");
  assert.equal(seen.maxTurns, "12");
  assert.ok(seen.cwd.startsWith(isoRoot), "the agent works in the trial's isolated workspace");
  assert.equal(seen.home, seen.cwd, "~ is the workspace, never the real home directory");
  await assert.rejects(readFile(seen.configDir), "the config dir is removed after the trial");

  // The key never appears in the report or the logs, even though the
  // "model" echoed it.
  const report = runner.summarize([trial]);
  const md = renderProviderMarkdownTable(report);
  assert.ok(!JSON.stringify(report).includes(KEY));
  assert.ok(!md.includes(KEY));
  const logs = await readdir(logDir);
  assert.equal(logs.length, 1);
  const log = await readFile(path.join(logDir, logs[0]), "utf8");
  assert.ok(log.includes("My key is"), "the log holds the transcript");
  assert.ok(!log.includes(KEY), "but never the key");
  assert.match(md, /\| live \| 1 \| 100\.0% \| 100\.0% \|/);
});

test("a wrong answer fails grading but completes as a run", async (t) => {
  const { bin, isoRoot, logDir } = await setup(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(isoRoot), executor: executor(bin, logDir), mode: "live" });
  const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-wrong" }], { tasks: [TASK] });
  assert.equal(trial.resolved, false);
  assert.equal(trial.exitReason, "completed");
  assert.ok(trial.grading.failed > 0);
  assert.equal(trial.metrics.totalTurns, 2);
  // No usage on the result line: per-message usage, m1 + m2 (two blocks of one message, counted once).
  assert.equal(trial.metrics.totalInputTokens, 1000 + 1500);
  assert.equal(trial.metrics.totalOutputTokens, 50 + 80);
});

test("hitting the turn ceiling is reported as max_turns, not a crash", async (t) => {
  const { bin, isoRoot, logDir } = await setup(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(isoRoot), executor: executor(bin, logDir), mode: "live" });
  const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-maxturns" }], { tasks: [TASK] });
  assert.equal(trial.exitReason, "max_turns");
  assert.equal(trial.metrics.totalTurns, 12);
  assert.equal(trial.metrics.totalInputTokens, 9000);
});

test("a run that never ends is killed at the timeout, process group included", async (t) => {
  const { dir, bin, isoRoot, logDir } = await setup(t);
  const runner = new ProviderEvalRunner({
    isolation: new LocalTempIsolation(isoRoot),
    executor: executor(bin, logDir, { timeoutMs: 1500 }),
    mode: "live",
  });
  const started = Date.now();
  const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-sleep" }], { tasks: [TASK] });
  assert.ok(Date.now() - started < 10_000, "the trial ends soon after the timeout");
  assert.equal(trial.exitReason, "timeout");
  assert.equal(trial.resolved, false);
  const childPid = Number(await readFile(path.join(dir, "child.pid"), "utf8"));
  // Give the SIGKILL sweep a moment, then the agent's own child must be gone.
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(childPid, 0), "the agent's background child was killed with the group");
});

test("a non-zero exit is an error with a short, redacted reason", async (t) => {
  const { bin, isoRoot, logDir } = await setup(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(isoRoot), executor: executor(bin, logDir), mode: "live" });
  const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-crash" }], { tasks: [TASK] });
  assert.equal(trial.exitReason, "error");
  assert.equal(trial.resolved, false);
  assert.ok(trial.exitDetail && trial.exitDetail.length > 0);
  assert.ok(!trial.exitDetail.includes(KEY));
});

test("a missing key env var fails fast with the variable's name, never a value", () => {
  assert.throws(
    () => buildLiveEnv({ provider: { kind: "openai", keyEnv: "NOPE_NOT_SET" }, env: {} }, "m", "/tmp/x"),
    /NOPE_NOT_SET is not set/,
  );
  const { env } = buildLiveEnv({ provider: { kind: "preconfigured" }, env: { PATH: "/bin", OTHER: "x" } }, "m", "/tmp/x");
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CLAUDE_CONFIG_DIR", "PATH"]);
});

test("foldLiveTelemetry prefers the CLI's own turn count and dedupes repeated usage", () => {
  const folded = foldLiveTelemetry([
    { type: "usage", inputTokens: 10, outputTokens: 1 },
    { type: "usage", inputTokens: 10, outputTokens: 1 },
    { type: "usage", inputTokens: 20, outputTokens: 2, cachedTokens: 5 },
    { type: "run.finished", exitCode: 0, sessionId: "s", numTurns: 4 },
  ]);
  assert.deepEqual([folded.turns, folded.inputTokens, folded.outputTokens], [4, 35, 3]);
});

test("LocalProcessExec returns the exit code and streams stdout", async () => {
  let out = "";
  const res = await new LocalProcessExec().exec([process.execPath, "-e", "process.stdout.write('hi'); process.exit(7)"], {
    env: { PATH: process.env.PATH ?? "" },
    onStdout: (c) => (out += c),
  });
  assert.equal(res.exitCode, 7);
  assert.equal(out, "hi");
});

test(
  "a desktop task boots Xvfb with its windows, wires only computer-mcp, folds desktop metrics, and tears down",
  { skip: missingDesktopBinaries().length > 0 ? `needs ${missingDesktopBinaries().join(", ")}` : false },
  async (t) => {
    const { dir, bin, isoRoot, logDir } = await setup(t);
    const task = { ...TASK, id: "desktop-wiring", desktop: { apps: [xtermApp("beta", undefined, "40x5+0+0")] } };
    const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(isoRoot), executor: executor(bin, logDir), mode: "live" });
    const [trial] = await runner.runSuite([{ providerId: "gw", model: "fake-pass" }], { tasks: [task] });
    assert.equal(trial.resolved, true, JSON.stringify(trial));

    const seen = JSON.parse(await readFile(path.join(dir, "last-desktop.json"), "utf8"));
    assert.equal(seen.betaWindow, true, "the task's window exists while the agent runs");
    assert.equal(seen.allowedTools, "mcp__computer-mcp");
    const server = seen.mcp.mcpServers["computer-mcp"];
    assert.match(server.args[0], /vm-image-desktop\/computer-mcp\/server\.mjs$/);
    assert.match(server.env.DISPLAY, /^:\d+$/);
    assert.deepEqual(seen.settings.permissions.allow, ["mcp__computer-mcp"]);
    for (const tool of ["Bash", "Write", "Edit", "Read"]) assert.ok(seen.settings.permissions.deny.includes(tool), tool);
    assert.notEqual(seen.settings.permissions.defaultMode, "acceptEdits");

    assert.deepEqual(trial.desktop, { computerActions: 1, noChangeEffects: 1, loopNudges: 0 });
    const n = server.env.DISPLAY.slice(1);
    for (let i = 0; i < 30 && existsSync(`/tmp/.X${n}-lock`); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(`/tmp/.X${n}-lock`), false, "Xvfb is gone after the trial");
  },
);
