/**
 * Tests for scripts/test-unit.sh: the unit-test wrapper must give each run
 * an isolated SWARM_HOME and remove it when the run ends — on success, on
 * failure, and never when the caller already provided a SWARM_HOME (which
 * scripts/test-all.sh does, and which the wrapper must leave alone).
 *
 * The real tsx run is replaced by a stub on PATH so these tests run in
 * milliseconds and never execute the suite: the stub records the
 * SWARM_HOME it saw and exits with a status the test chooses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./test-unit.sh", import.meta.url));

interface RunSetup {
  scratch: string;
  seenFile: string;
  stubDir: string;
}

/** A scratch dir holding a stub `tsx` and the file it records SWARM_HOME to. */
function setup(exitCode: number, sleepSeconds = 0): RunSetup {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-unit-"));
  const seenFile = path.join(scratch, "seen-home");
  const stubDir = path.join(scratch, "bin");
  fs.mkdirSync(stubDir);
  const stub = path.join(stubDir, "tsx");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      (sleepSeconds > 0 ? `sleep ${sleepSeconds}\n` : ``) +
      `printf '%s' "$SWARM_HOME" > "${seenFile}"\n` +
      `exit ${exitCode}\n`,
  );
  fs.chmodSync(stub, 0o755);
  return { scratch, seenFile, stubDir };
}

function cleanup(setup: RunSetup): void {
  fs.rmSync(setup.scratch, { recursive: true, force: true });
}

function childEnv(setup: RunSetup, extraEnv: Record<string, string> = {}): Record<string, string> {
  // The wrapper only creates a home when the caller did not provide one —
  // and the suite itself runs under a SWARM_HOME set by the outer wrapper.
  // Strip it here so the spawned wrapper behaves like a direct `npm run
  // test:unit` invocation; the caller-provided test passes one explicitly
  // via extraEnv instead.
  const base = { ...process.env };
  delete base.SWARM_HOME;
  return { ...base, PATH: `${setup.stubDir}:${process.env.PATH ?? ""}`, ...extraEnv } as Record<
    string,
    string
  >;
}

function runScript(setup: RunSetup, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: childEnv(setup, extraEnv),
  });
  assert.equal(result.error, undefined, `script failed to spawn: ${result.error}`);
  return result;
}

function runScriptAsync(setup: RunSetup): Promise<{ status: number | null }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("bash", [SCRIPT], {
      env: childEnv(setup),
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status }));
  });
}

function readSeen(setup: RunSetup): string {
  return fs.readFileSync(setup.seenFile, "utf8");
}

test("a successful run removes its temp SWARM_HOME", () => {
  const run = setup(0);
  try {
    const result = runScript(run);
    assert.equal(result.status, 0);
    const home = readSeen(run);
    assert.ok(home.startsWith(os.tmpdir()), `expected a temp home, saw ${home}`);
    assert.ok(path.basename(home).startsWith("tmp."), `expected a mktemp dir, saw ${home}`);
    assert.equal(fs.existsSync(home), false, "the temp home must be removed after the run");
  } finally {
    cleanup(run);
  }
});

test("a failing run still removes its temp SWARM_HOME and keeps the exit code", () => {
  const run = setup(3);
  try {
    const result = runScript(run);
    assert.equal(result.status, 3, "the wrapper must pass the suite's exit code through");
    assert.equal(fs.existsSync(readSeen(run)), false, "the temp home must be removed after a failure too");
  } finally {
    cleanup(run);
  }
});

test("a caller-provided SWARM_HOME is used as-is and never deleted", () => {
  const run = setup(0);
  const provided = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-provided-home-"));
  try {
    const result = runScript(run, { SWARM_HOME: provided });
    assert.equal(result.status, 0);
    assert.equal(readSeen(run), provided, "the stub must see the caller's home, not a fresh one");
    assert.equal(fs.existsSync(provided), true, "a caller-provided home must survive the run");
  } finally {
    cleanup(run);
    fs.rmSync(provided, { recursive: true, force: true });
  }
});

test("parallel runs get different homes and both are cleaned up", async () => {
  const first = setup(0, 0.5);
  const second = setup(0, 0.5);
  try {
    const [a, b] = await Promise.all([runScriptAsync(first), runScriptAsync(second)]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    const homeA = readSeen(first);
    const homeB = readSeen(second);
    assert.notEqual(homeA, homeB, "parallel runs must not share a SWARM_HOME");
    assert.equal(fs.existsSync(homeA), false, "the first run's home must be removed");
    assert.equal(fs.existsSync(homeB), false, "the second run's home must be removed");
  } finally {
    cleanup(first);
    cleanup(second);
  }
});
