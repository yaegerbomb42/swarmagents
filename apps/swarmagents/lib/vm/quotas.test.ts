import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { bindExec, VmManager } from "./manager.js";
import {
  QuotaError,
  OutputCap,
  TRUNCATION_MARKER,
  DEFAULT_VM_QUOTAS,
  resolveVmQuotas,
  sliceToByteLimit,
} from "./quotas.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// QuotaError typing
// ---------------------------------------------------------------------------

test("QuotaError is a typed Error with kind, limit and userId", () => {
  const err = new QuotaError("max_concurrent_execs", 2, "alice");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "QuotaError");
  assert.equal(err.kind, "max_concurrent_execs");
  assert.equal(err.limit, 2);
  assert.equal(err.userId, "alice");
  assert.match(err.message, /quota exceeded/);
});

// ---------------------------------------------------------------------------
// Quota resolution: defaults, env vars, explicit overrides
// ---------------------------------------------------------------------------

test("resolveVmQuotas defaults match DEFAULT_VM_QUOTAS", () => {
  assert.deepEqual(resolveVmQuotas(), DEFAULT_VM_QUOTAS);
  assert.equal(DEFAULT_VM_QUOTAS.maxConcurrentExecsPerUser, 2);
  assert.equal(DEFAULT_VM_QUOTAS.maxExecDurationMs, 5 * 60_000);
  assert.equal(DEFAULT_VM_QUOTAS.maxOutputBytes, 1024 * 1024);
  assert.equal(DEFAULT_VM_QUOTAS.agentMaxExecDurationMs, 2 * 60 * 60_000);
  assert.equal(DEFAULT_VM_QUOTAS.agentMaxOutputBytes, 64 * 1024 * 1024);
});

test("resolveVmQuotas reads SWARM_VM_* env vars", () => {
  const prev = { ...process.env };
  try {
    process.env.SWARM_VM_MAX_CONCURRENT_EXECS = "5";
    process.env.SWARM_VM_MAX_EXEC_MS = "60000";
    process.env.SWARM_VM_MAX_OUTPUT_BYTES = "2048";
    process.env.SWARM_VM_AGENT_MAX_EXEC_MS = "7200001";
    process.env.SWARM_VM_AGENT_MAX_OUTPUT_BYTES = "67108865";
    const q = resolveVmQuotas();
    assert.equal(q.maxConcurrentExecsPerUser, 5);
    assert.equal(q.maxExecDurationMs, 60000);
    assert.equal(q.maxOutputBytes, 2048);
    assert.equal(q.agentMaxExecDurationMs, 7200001);
    assert.equal(q.agentMaxOutputBytes, 67108865);
  } finally {
    for (const k of [
      "SWARM_VM_MAX_CONCURRENT_EXECS",
      "SWARM_VM_MAX_EXEC_MS",
      "SWARM_VM_MAX_OUTPUT_BYTES",
      "SWARM_VM_AGENT_MAX_EXEC_MS",
      "SWARM_VM_AGENT_MAX_OUTPUT_BYTES",
    ]) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("resolveVmQuotas: explicit options win over env; invalid values fall back", () => {
  const prev = { ...process.env };
  try {
    process.env.SWARM_VM_MAX_CONCURRENT_EXECS = "7";
    assert.equal(resolveVmQuotas().maxConcurrentExecsPerUser, 7);
    assert.equal(resolveVmQuotas({ maxConcurrentExecsPerUser: 3 }).maxConcurrentExecsPerUser, 3);

    process.env.SWARM_VM_MAX_EXEC_MS = "not-a-number";
    assert.equal(resolveVmQuotas().maxExecDurationMs, DEFAULT_VM_QUOTAS.maxExecDurationMs);
    process.env.SWARM_VM_MAX_OUTPUT_BYTES = "-5";
    assert.equal(resolveVmQuotas().maxOutputBytes, DEFAULT_VM_QUOTAS.maxOutputBytes);

    process.env.SWARM_VM_AGENT_MAX_EXEC_MS = "-1";
    process.env.SWARM_VM_AGENT_MAX_OUTPUT_BYTES = "invalid";
    assert.equal(resolveVmQuotas().agentMaxExecDurationMs, DEFAULT_VM_QUOTAS.agentMaxExecDurationMs);
    assert.equal(resolveVmQuotas().agentMaxOutputBytes, DEFAULT_VM_QUOTAS.agentMaxOutputBytes);

    // 0 explicitly disables a quota.
    assert.equal(resolveVmQuotas({ maxConcurrentExecsPerUser: 0 }).maxConcurrentExecsPerUser, 0);
  } finally {
    for (const k of [
      "SWARM_VM_MAX_CONCURRENT_EXECS",
      "SWARM_VM_MAX_EXEC_MS",
      "SWARM_VM_MAX_OUTPUT_BYTES",
      "SWARM_VM_AGENT_MAX_EXEC_MS",
      "SWARM_VM_AGENT_MAX_OUTPUT_BYTES",
    ]) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

// ---------------------------------------------------------------------------
// OutputCap: truncation with marker
// ---------------------------------------------------------------------------

test("OutputCap truncates past the byte cap and appends the marker once", () => {
  const chunks: string[] = [];
  const cap = new OutputCap(8, (c) => chunks.push(c));
  cap.write("01234567");
  cap.write("89ABCDEF");
  cap.write("more");
  const out = chunks.join("");
  assert.ok(out.startsWith("01234567"));
  assert.ok(out.includes("[output truncated"));
  assert.equal(chunks.filter((c) => c === TRUNCATION_MARKER).length, 1);
  assert.equal(cap.didTruncate, true);
});

test("OutputCap never splits a multi-byte code point", () => {
  const chunks: string[] = [];
  const cap = new OutputCap(3, (c) => chunks.push(c));
  cap.write("ééé"); // 6 utf8 bytes, 3 code points
  const out = chunks.join("");
  assert.ok(out.startsWith("é")); // only the first 2-byte char fits
  assert.ok(out.includes("[output truncated"));
});

test("OutputCap with limit 0 forwards unbounded", () => {
  const chunks: string[] = [];
  const cap = new OutputCap(0, (c) => chunks.push(c));
  cap.write("a".repeat(100));
  assert.equal(chunks.join("").length, 100);
  assert.equal(cap.didTruncate, false);
});

test("sliceToByteLimit respects utf8 boundaries", () => {
  assert.equal(sliceToByteLimit("abc", 5), "abc");
  assert.equal(sliceToByteLimit("abcd", 3), "abc");
  assert.equal(sliceToByteLimit("éé", 3), "é"); // 4 bytes total, only 2 fit
  assert.equal(sliceToByteLimit("éé", 0), "");
});

// ---------------------------------------------------------------------------
// VmManager: max concurrent execs per user
// ---------------------------------------------------------------------------

test("VmManager default quota allows 2 concurrent execs and rejects the 3rd with QuotaError", async () => {
  class GatedFake extends FakeVmDriver {
    gates: Array<() => void> = [];
    override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] === "echo") await new Promise<void>((resolve) => this.gates.push(resolve));
      return super.exec(h, cmd, opts);
    }
  }
  const driver = new GatedFake();
  const manager = new VmManager({ customDriver: driver });

  assert.equal(manager.quotas.maxConcurrentExecsPerUser, 2);

  const p1 = manager.exec("alice", ["echo", "1"]);
  await flush();
  const p2 = manager.exec("alice", ["echo", "2"]);
  await flush();

  // A third exec for the same user is over the cap.
  await assert.rejects(
    manager.exec("alice", ["echo", "3"]),
    (err: unknown) => err instanceof QuotaError && err.kind === "max_concurrent_execs" && err.userId === "alice",
  );

  // Other users are unaffected.
  const other = await manager.exec("bob", ["true"]);
  assert.equal(other.exitCode, 0);

  // Completing execs frees slots for later attempts.
  driver.gates[0]!();
  assert.deepEqual(await p1, { exitCode: 0 });
  await flush();

  driver.gates[1]!();
  await flush();

  const p3 = manager.exec("alice", ["echo", "3"]);
  await flush();
  driver.gates[2]!();
  const res = await p3;
  assert.equal(res.exitCode, 0);
});

test("VmManager concurrency quota: 0 disables the limit", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { maxConcurrentExecsPerUser: 0 },
  });

  const execs = [1, 2, 3, 4, 5].map((i) => manager.exec("alice", ["echo", String(i)]));
  for (const p of execs) assert.deepEqual(await p, { exitCode: 0 });
});

// ---------------------------------------------------------------------------
// VmManager: max exec duration
// ---------------------------------------------------------------------------

test("VmManager rejects execs that exceed maxExecDurationMs with QuotaError", async () => {
  class HangingDriver extends FakeVmDriver {
    override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      return new Promise<ExecResult>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    }
  }
  const manager = new VmManager({
    customDriver: new HangingDriver(),
    quotas: { maxExecDurationMs: 20 },
  });

  await assert.rejects(
    manager.exec("alice", ["sleep", "forever"]),
    (err: unknown) => err instanceof QuotaError && err.kind === "max_exec_duration" && err.limit === 20,
  );

  // A completed exec within the limit is untouched.
  const quick = new VmManager({
    customDriver: new FakeVmDriver(),
    quotas: { maxExecDurationMs: 5_000 },
  });
  assert.equal((await quick.exec("alice", ["true"])).exitCode, 0);
});

test("VmManager duration quota: 0 disables the limit", async () => {
  class HangingDriver extends FakeVmDriver {
    override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      return new Promise<ExecResult>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    }
  }
  const manager = new VmManager({
    customDriver: new HangingDriver(),
    quotas: { maxExecDurationMs: 0 },
  });

  const p = manager.exec("alice", ["sleep"]);
  const failure = p.then(
    () => {
      throw new Error("should not resolve");
    },
    () => "rejected",
  );
  const raced = await Promise.race([failure, new Promise((r) => setTimeout(() => r("still-running"), 60))]);
  assert.equal(raced, "still-running");
});

// ---------------------------------------------------------------------------
// VmManager: max output bytes captured
// ---------------------------------------------------------------------------

test("VmManager truncates captured output past maxOutputBytes with a marker", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { maxOutputBytes: 8 },
  });

  const chunks: string[] = [];
  const res = await manager.exec("alice", ["echo", "0123456789ABCDEF"], {
    onStdout: (c) => chunks.push(c),
  });

  const out = chunks.join("");
  assert.ok(out.startsWith("01234567"), `expected capped prefix, got ${JSON.stringify(out)}`);
  assert.ok(!out.includes("89ABCDEF"), "bytes past the cap must not be forwarded");
  assert.ok(out.includes("[output truncated"));
  assert.equal(res.truncated, true);
});

test("VmManager output quota covers stderr too", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { maxOutputBytes: 5 },
  });

  const stderr: string[] = [];
  const res = await manager.exec("alice", ["cat", "missing.txt"], {
    onStderr: (c) => stderr.push(c),
  });

  const out = stderr.join("");
  assert.ok(out.startsWith("cat: "));
  assert.ok(out.includes("[output truncated"));
  assert.equal(res.truncated, true);
  assert.equal(res.exitCode, 1);
});

test("VmManager output quota: 0 disables truncation and truncated stays false", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { maxOutputBytes: 0 },
  });

  const chunks: string[] = [];
  const res = await manager.exec("alice", ["echo", "0123456789ABCDEF"], {
    onStdout: (c) => chunks.push(c),
  });
  assert.equal(chunks.join(""), "0123456789ABCDEF\n");
  assert.equal(res.truncated, undefined);
});

test("VmManager output quota is shared by stdout and stderr", async () => {
  class BothStreamsDriver extends FakeVmDriver {
    override async exec(_h: VmHandle, _cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      opts?.onStdout?.("12345");
      opts?.onStderr?.("67890");
      return { exitCode: 0 };
    }
  }
  const manager = new VmManager({
    customDriver: new BothStreamsDriver(),
    quotas: { maxOutputBytes: 6 },
  });
  const out: string[] = [];
  const err: string[] = [];
  const res = await manager.exec("alice", ["anything"], {
    onStdout: (c) => out.push(c),
    onStderr: (c) => err.push(c),
  });
  const combined = out.join("") + err.join("");
  assert.ok(combined.startsWith("123456"), combined);
  assert.ok(combined.includes("[output truncated"));
  assert.equal(res.truncated, true);
});

test("bound agent execs use long-run quotas instead of short terminal defaults", async () => {
  class ProfileDriver extends FakeVmDriver {
    override async exec(_h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] === "slow") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      opts?.onStdout?.("0123456789abcdef");
      return { exitCode: 0 };
    }
  }
  const manager = new VmManager({
    customDriver: new ProfileDriver(),
    quotas: {
      maxExecDurationMs: 5,
      agentMaxExecDurationMs: 1_000,
      maxOutputBytes: 4,
      agentMaxOutputBytes: 64,
    },
  });

  // The same invocation would be killed by the five-ms terminal duration cap.
  await assert.rejects(
    manager.exec("alice", ["slow"]),
    (err: unknown) => err instanceof QuotaError && err.kind === "max_exec_duration",
  );

  // bindExec marks Claude invocations as agent work: the longer deadline and
  // output budget both apply, so output well past the terminal cap survives.
  const chunks: string[] = [];
  const agent = await bindExec(manager, "alice").exec(["slow"], {
    onStdout: (chunk) => chunks.push(chunk),
  });
  assert.equal(chunks.join(""), "0123456789abcdef");
  assert.equal(agent.truncated, undefined);

  // Ordinary terminal execs still retain their small output cap.
  const terminalChunks: string[] = [];
  const terminal = await manager.exec("alice", ["quick"], {
    onStdout: (chunk) => terminalChunks.push(chunk),
  });
  assert.equal(terminal.truncated, true);
  assert.match(terminalChunks.join(""), /output truncated/);
});
