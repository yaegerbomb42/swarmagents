/**
 * Runtime #6 — the agent exec runs in its own process group (setsid) with
 * its pgid recorded in a marker file, and the cancel backstop kills exactly
 * that group. The old `pkill -KILL -P 1` killed the desktop session in
 * desktop VMs (PID 1 is supervisord). No Docker daemon is required: the
 * argv tests use an injectable spawn, and the kill mechanics run against a
 * real local shell.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import {
  DockerVmDriver,
  buildExecKillArgs,
  buildPgidKillCommand,
  buildTrackedCommand,
  containerNameFor,
  execPgidPath,
  validPgidFile,
} from "./docker-driver.js";
import type { VmHandle } from "./types.js";

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

/** Capture the argv of every spawned docker CLI invocation. */
function capturingDriver() {
  const spawned: Array<readonly string[]> = [];
  const child = () => {
    const emitter = new EventEmitter();
    const cp = Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true,
    }) as unknown as import("node:child_process").ChildProcess;
    // Settle the exec immediately, like a fast `docker exec`.
    queueMicrotask(() => emitter.emit("close", 0));
    return cp;
  };
  const driver = new DockerVmDriver({
    spawnFn: (_cmd: string, argv: readonly string[]) => {
      spawned.push(argv);
      return child();
    },
    desktop: false,
  });
  return { driver, spawned };
}

test("driver honors a caller-supplied pgid file for a tracked exec", async () => {
  const { driver, spawned } = capturingDriver();
  const pgidFile = "/tmp/.swarm-exec-run_test123.pgid";
  const result = await driver.exec(handle(), ["echo", "hi"], {
    signal: new AbortController().signal,
    pgidFile,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(spawned.length, 1);
  const argv = spawned[0]!;
  // The tracked wrapper (setsid -w) runs with the supplied marker path.
  assert.ok(argv.includes("setsid -w") || argv.join(" ").includes("setsid -w"), "expected setsid wrapper in argv");
  assert.ok(argv.includes(pgidFile), `expected the supplied pgid file in argv: ${argv.join(" ")}`);
});

test("driver rejects a pgid file outside the exec scratch dir", () => {
  assert.equal(validPgidFile("/tmp/.swarm-exec-run_abc.pgid"), "/tmp/.swarm-exec-run_abc.pgid");
  assert.equal(validPgidFile("/etc/passwd"), undefined);
  assert.equal(validPgidFile("/tmp/evil.pgid"), undefined);
  assert.equal(validPgidFile("/tmp/.swarm-exec-x.pgid; rm -rf /"), undefined);
  assert.equal(validPgidFile(undefined), undefined);
  assert.equal(execPgidPath("run_abc"), "/tmp/.swarm-exec-run_abc.pgid");
});

test("driver falls back to a random marker when the supplied pgid file is invalid", async () => {
  const { driver, spawned } = capturingDriver();
  await driver.exec(handle(), ["echo", "hi"], {
    signal: new AbortController().signal,
    pgidFile: "/etc/passwd",
  });
  const argv = spawned[0]!.join(" ");
  assert.ok(!argv.includes("/etc/passwd"), "an invalid pgid file must never reach argv");
  assert.match(argv, /\/tmp\/\.swarm-exec-[0-9a-f]+\.pgid/);
});

test("pgid kill command kills only the recorded process group (live shell)", { skip: spawnSync("setsid", ["--version"]).status !== 0 ? "setsid is unavailable on this host" : undefined }, async () => {
  const id = `test-${process.pid}-${Date.now()}`;
  const pgidFile = execPgidPath(id);
  // Spawn through the exact tracked wrapper the driver uses for agent execs.
  const tracked = buildTrackedCommand(pgidFile, ["sleep", "60"]);
  const victim = spawn(tracked[0], tracked.slice(1), { stdio: "ignore" });
  // A sibling process in a different group: it must survive the kill.
  const sibling = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    // Wait for the wrapper to record its pgid.
    let pgid = "";
    for (let i = 0; i < 40 && !pgid; i++) {
      try {
        pgid = fs.readFileSync(pgidFile, "utf8").trim();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(pgid, "the wrapper must record its pgid");
    const pgidNum = Number(pgid);
    assert.ok(Number.isInteger(pgidNum) && pgidNum > 0);
    assert.doesNotThrow(() => process.kill(pgidNum, 0), "the group leader must be alive before the kill");
    assert.doesNotThrow(() => process.kill(sibling.pid!, 0), "the sibling must be alive before the kill");

    // The exact command the manager's cancel backstop runs.
    const killArgv = buildPgidKillCommand(pgidFile);
    assert.equal(killArgv[0], "sh");
    assert.match(killArgv[2], /kill -KILL "-\$pgid"/);
    assert.ok(!killArgv.join(" ").includes("pkill"), "the backstop must never pkill");
    // dash's kill builtin rejects `--` when the signal is `-SIGNAME`
    // (rc 2, group survives): the KILL builder must not emit it.
    assert.ok(!killArgv.join(" ").includes(" -- "), "dash kill -SIGNAME rejects `--`");
    const kill = spawnSync(killArgv[0], killArgv.slice(1), { encoding: "utf8" });
    assert.equal(kill.status, 0, `kill command failed: ${kill.stderr}`);

    // The group is dead, its marker is gone, the sibling is untouched.
    // (waitForExit first: kill(pid, 0) still succeeds while the child is
    // an unreaped zombie, so the ESRCH check is only meaningful after
    // Node reaped it. The boolean proves the scoped kill did the work —
    // a timeout force-kill would return false instead of masking a miss.)
    assert.equal(fs.existsSync(pgidFile), false, "the marker file must be removed by the kill");
    assert.doesNotThrow(() => process.kill(sibling.pid!, 0), "the sibling must survive the scoped kill");
    assert.equal(await waitForExit(victim), true, "the scoped kill must have ended the group");
    assert.throws(() => process.kill(pgidNum, 0), /ESRCH/);

    // Same mechanics for the abort-time cleanup (SIGTERM form): a second
    // victim group must die to the buildExecKillArgs script. Note the dash
    // quirk runs the other way here: with `-s TERM` the `--` is REQUIRED
    // (without it the -NNN is parsed as an option and the kill fails).
    const termArgv = buildExecKillArgs("swarm-test", pgidFile);
    const termScript = termArgv[termArgv.indexOf("-c") + 1];
    assert.ok(termScript, "expected a -c script in the abort cleanup argv");
    assert.match(termScript, /kill -s TERM -- "-\$pgid"/);
    const victim2 = spawn(tracked[0], tracked.slice(1), { stdio: "ignore" });
    let pgid2 = "";
    for (let i = 0; i < 40 && !pgid2; i++) {
      try {
        pgid2 = fs.readFileSync(pgidFile, "utf8").trim();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(pgid2, "the second wrapper must record its pgid");
    const term = spawnSync("sh", ["-c", termScript, "sh", pgidFile], { encoding: "utf8" });
    assert.equal(term.status, 0, `abort cleanup failed: ${term.stderr}`);
    assert.equal(await waitForExit(victim2), true, "the abort cleanup must have ended the group");
    assert.throws(() => process.kill(Number(pgid2), 0), /ESRCH/);
  } finally {
    try {
      process.kill(sibling.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(-Number(fs.readFileSync(pgidFile, "utf8").trim()), "SIGKILL");
    } catch {
      // already gone (or never recorded)
    }
    try {
      fs.rmSync(pgidFile, { force: true });
    } catch {
      // already gone
    }
  }
});

/** Wait for a spawned child to exit, force-killing its group if it hangs. */
async function waitForExit(child: import("node:child_process").ChildProcess, timeoutMs = 5000): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) =>
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
        resolve(false);
      }, timeoutMs),
    ),
  ]);
}
