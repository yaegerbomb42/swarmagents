/**
 * End-to-end dispatch test: real API handlers + fake VM driver + fake claude
 * binary + the SSE stream handler.
 *
 * A recorded `claude --output-format stream-json` transcript is written to an
 * executable "claude" script on disk. The fake VM driver spawns that script so
 * the whole loop is exercised: POST /api/runtime/tasks -> RuntimeManager ->
 * ClaudeCodeRunner -> fake VM -> telemetry bus -> GET /api/runtime/stream.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST } from "./tasks/route";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import * as fx from "./dispatch-fixtures.test";

const USER = "e2e-dispatch";

// Spawns a real fake-`claude` child and blocks on the SSE stream for
// run.finished, which can hang in sandboxed worker environments. Opt in with
// SWARM_RUN_DISPATCH_E2E=1 (see README "Running tests"); the default suite
// proves the same ordering invariants in dispatch.test.ts with a scripted
// driver that never spawns and never leaves the event loop open.
const RUN_DISPATCH_E2E = process.env.SWARM_RUN_DISPATCH_E2E === "1";
const DISPATCH_E2E_TIMEOUT_MS = 120_000;

/** Fake VM driver that actually spawns the recorded fake claude binary. */
class BinaryFakeVmDriver extends fx.RecordingDispatchDriver {
  constructor(private readonly claudeBin: string) {
    super();
  }

  protected override async execAgent(_handle: VmHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult | null> {
    if (cmd[0] !== this.claudeBin) return null;

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        // `opts.cwd` is the VM-relative workspace path (e.g. /workspace),
        // which does not exist on the host. This driver runs the recorded
        // transcript on the host, so let the child inherit the host cwd.
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onAbort = () => child.kill("SIGTERM");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => opts.onStdout?.(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => opts.onStderr?.(chunk.toString("utf8")));
      child.on("error", (error) => {
        opts.signal?.removeEventListener("abort", onAbort);
        opts.onStderr?.(`${error.message}\n`);
        resolve({ exitCode: 1 });
      });
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? 1 });
      });
    });
  }
}

function makeFakeClaude(dir: string): string {
  const fixture = join(dir, "stream-json.fixture");
  writeFileSync(fixture, `${fx.recordedLines("sess_e2e_1").map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const bin = join(dir, "claude");
  // Read prompt from the argument after `--` (kept for harness contract parity).
  writeFileSync(
    bin,
    `#!/bin/sh
prompt=""
seen=""
for arg in "$@"; do
  if [ "$seen" = "1" ]; then prompt="$arg"; break; fi
  if [ "$arg" = "--" ]; then seen="1"; fi
done
exec cat "${fixture}"
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return bin;
}

fx.useRuntimeCleanup();

test(
  "POST dispatches to the fake claude binary and SSE streams started..finished in order",
  { skip: !RUN_DISPATCH_E2E, timeout: DISPATCH_E2E_TIMEOUT_MS },
  async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-e2e-"));
  const previousBin = process.env.CLAUDE_BIN;
  try {
    const claudeBin = makeFakeClaude(dir);
    process.env.CLAUDE_BIN = claudeBin;
    const driver = new BinaryFakeVmDriver(claudeBin);
    fx.installRuntime(driver);

    const post = await POST(fx.dispatchTaskRequest("run the e2e dispatch", USER));
    const events = await fx.dispatchEvents(post, USER);

    fx.assertDispatchOrdering(events);

    const ready = events.find((event) => event.type === "vm.ready");
    const readyData = ready?.data as { ms?: number } | undefined;
    assert.equal(typeof readyData?.ms, "number");

    fx.assertDispatchLifecycle(events, "sess_e2e_1");

    fx.assertAgentExec(driver.calls, claudeBin, "run the e2e dispatch");

  } finally {
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  }
  },
);
