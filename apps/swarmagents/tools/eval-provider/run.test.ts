// CLI tests for the multi-provider desktop eval. Exercises the real CLI
// end to end (full suite, scripted executors + FakeVmDriver) and checks the
// exit-code + report-output contract.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "./run";

const execFileAsync = promisify(execFile);

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(APP_DIR, "tools/eval-provider/run.ts");

test("parseArgs defaults and flags", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.providers.length, 1);
  assert.equal(defaults.trials, 1);
  assert.equal(defaults.vm, "fake");
  const custom = parseArgs([
    "--providers", "anthropic,openai",
    "--trials", "2",
    "--out", "out",
    "--vm", "none",
  ]);
  assert.deepEqual(custom.providers.map((p) => p.providerId), ["anthropic", "openai"]);
  assert.equal(custom.trials, 2);
  assert.equal(custom.outDir, "out");
  assert.equal(custom.vm, "none");
  assert.throws(() => parseArgs(["--vm", "bogus"]), /--vm must be one of/);
});

test("parseArgs live mode: key by env var name only, provider label from the host, VM off", () => {
  const live = parseArgs([
    "--live",
    "--base-url", "https://gw.example.com/v1",
    "--model", "nvidia/nemotron-x",
    "--key-env", "MY_KEY",
    "--kind", "openai",
    "--max-turns", "20",
    "--timeout-s", "300",
    "--tasks", "coding-fix-rate-limiter",
  ]);
  assert.deepEqual(live.live?.provider, { kind: "openai", keyEnv: "MY_KEY", baseUrl: "https://gw.example.com/v1" });
  assert.equal(live.live?.maxTurns, 20);
  assert.equal(live.live?.timeoutS, 300);
  assert.equal(live.vm, "none");
  assert.deepEqual(live.providers, [{ providerId: "gw.example.com", model: "nvidia/nemotron-x" }]);
  assert.deepEqual(live.tasks, ["coding-fix-rate-limiter"]);
  // A pasted key is refused: the flag takes a variable name.
  assert.throws(() => parseArgs(["--live", "--model", "m", "--key-env", "sk-abc-123"]), /variable NAME/);
  assert.throws(() => parseArgs(["--live", "--key-env", "MY_KEY"]), /needs --model/);
  assert.throws(() => parseArgs(["--live", "--model", "m"]), /needs --key-env/);
  const wrapper = parseArgs(["--live", "--model", "m", "--claude-bin", "/opt/claude-wrapper"]);
  assert.deepEqual(wrapper.live?.provider, { kind: "preconfigured" });
  assert.equal(wrapper.live?.claudeBin, "/opt/claude-wrapper");
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", CLI, ...args],
      { cwd: APP_DIR, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("CLI runs the full suite across two providers and writes the report", async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "provider-eval-cli-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { code, stdout } = await runCli([
    "--providers", "anthropic,openai",
    "--vm", "fake",
    "--out", out,
  ]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /# Multi-Provider Real-Task Desktop Eval/);
  assert.match(stdout, /\| anthropic \|/);
  assert.match(stdout, /\| openai \|/);
  const json = JSON.parse(await readFile(path.join(out, "provider-eval-report.json"), "utf8"));
  assert.equal(json.rows.length, 2);
  assert.equal(json.rows[0].completionRate, 1);
  const md = await readFile(path.join(out, "provider-eval-report.md"), "utf8");
  assert.match(md, /anthropic/);
});

test("CLI --vm docker is rejected in CI (local/manual only)", async () => {
  const { code, stderr } = await runCli(["--vm", "docker"]);
  assert.equal(code, 2);
  assert.match(stderr, /local\/manual runs only/);
});
