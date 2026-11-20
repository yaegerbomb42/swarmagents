/**
 * End-to-end long-term memory test.
 *
 * Run 1: the user tells the agent a preference and the agent stores it with
 * the memory_write tool. The call travels agent -> in-VM MCP server -> host
 * bridge -> the account's store, so the fact ends up in the app's per-user
 * data directory.
 *
 * Run 2: the VM is reset (the container is thrown away) and a new run starts.
 * The account's memory is injected into the run's system prompt, so the agent
 * starts the run already knowing the preference.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./tasks/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { telemetryBus } from "../../../lib/telemetry/bus";
import { configureProviderStorePaths } from "../../../lib/providers/store";
import { listMemories } from "../../../lib/memory/store";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";

const USER = "e2e-memory";
const PREFERENCE = "I prefer pnpm over npm for package management";

/** The fake VM driver that also records every claude invocation. */
class RecordingFakeVmDriver extends FakeVmDriver {
  claudeArgv: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const base = cmd[0]?.replace(/\\/g, "/").split("/").pop();
    if (base === "claude") this.claudeArgv.push(cmd);
    return super.exec(handle, cmd, opts);
  }
}

function taskRequest(prompt: string): NextRequest {
  return new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: new Headers({ "x-swarm-user": USER }),
    body: JSON.stringify({ prompt }),
  });
}

/** Resolve when the run reaches a terminal state. */
function waitForTerminal(
  runId: string,
  timeoutMs = 30_000,
): Promise<{ type: string; events: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const events: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`run ${runId} did not finish in ${timeoutMs}ms`));
    }, timeoutMs);
    unsubscribe = telemetryBus.subscribe(runId, 0, (event) => {
      events.push(event as unknown as Record<string, unknown>);
      if (event.type !== "run.finished" && event.type !== "run.error") return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve({ type: event.type, events });
    });
  });
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("a preference told in run 1 is recalled in run 2, after the VM was reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-e2e-"));
  configureProviderStorePaths(join(dir, "providers.json"));
  const driver = new RecordingFakeVmDriver();
  const vm = new VmManager({ customDriver: driver });
  setRuntimeManagerForTesting(new RuntimeManager({ vm }));

  try {
    // --- Run 1: the user tells the agent a preference. -------------------
    const first = await POST(taskRequest(`remember this preference: ${PREFERENCE}`));
    assert.equal(first.status, 201);
    const { runId: firstRunId } = (await first.json()) as { runId: string };
    const firstTerminal = await waitForTerminal(firstRunId);
    assert.equal(firstTerminal.type, "run.finished");

    // The agent really called the memory tool and got the host's answer.
    const toolCall = firstTerminal.events.find(
      (event) =>
        event.type === "tool.call" &&
        String((event as { name?: string }).name ?? "").includes("memory_write"),
    );
    assert.ok(toolCall, "the agent never called the memory_write tool");
    const toolResult = firstTerminal.events.find((event) => event.type === "tool.result");
    assert.ok(toolResult, "the memory tool never returned a result");
    assert.match(String((toolResult as { output?: string }).output ?? ""), /"ok":true/);

    // The fact landed in the account's store (on the host, not in the VM).
    const memories = listMemories(USER);
    assert.equal(memories.length, 1);
    assert.match(memories[0].fact, /pnpm/);
    assert.deepEqual(memories[0].tags, ["preference"]);

    // The store is per-account: another account sees nothing.
    assert.deepEqual(listMemories("someone-else"), []);

    // --- The VM is reset: the container (and its disk) is thrown away. ---
    await vm.reset(USER);

    // --- Run 2: a new run starts with the memory injected. --------------
    const second = await POST(taskRequest("Which package manager should I use?"));
    assert.equal(second.status, 201);
    const { runId: secondRunId } = (await second.json()) as { runId: string };
    const secondTerminal = await waitForTerminal(secondRunId);
    assert.equal(secondTerminal.type, "run.finished");

    const claudeCalls = driver.claudeArgv;
    assert.equal(claudeCalls.length, 2, "expected one claude invocation per run");

    const systemPrompt = claudeCalls[1][claudeCalls[1].indexOf("--append-system-prompt") + 1];
    assert.ok(systemPrompt, "the second run carried no appended system prompt");
    assert.match(systemPrompt, /Long-term memory for this account/);
    assert.match(systemPrompt, /pnpm/);

    // The first run had nothing to inject (the account had no memory yet).
    const firstSystemPrompt = claudeCalls[0][claudeCalls[0].indexOf("--append-system-prompt") + 1] ?? "";
    assert.ok(!firstSystemPrompt.includes("Long-term memory for this account"));
  } finally {
    setRuntimeManagerForTesting(null);
    configureProviderStorePaths("");
    rmSync(dir, { recursive: true, force: true });
  }
});
