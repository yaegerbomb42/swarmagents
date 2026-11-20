/**
 * An installed Library item is usable by the installer's next run: the run
 * seeds the skill into its VM, wires the custom-tools MCP server into
 * --mcp-config, and grants the MCP permissions on the claude argv.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { configureRunsDir } from "../telemetry/paths";
import { configureLibraryStoreDir, addInstalledItem, deleteInstalledItem } from "../library/user-store";
import { libraryServerName, LIBRARY_TOOLS_SERVER_NAME } from "../library/run-seed";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../vm/types";
import type { RunSummary } from "./manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class CapturingFakeVm extends FakeVmDriver {
  claudeCalls: string[][] = [];
  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") this.claudeCalls.push(cmd);
    return super.exec(handle, cmd, opts);
  }
}

async function waitForDone(manager: RuntimeManager, userId: string, steps = 400): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (runs.length > 0 && runs.every((run) => run.status !== "running" && run.status !== "queued")) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for the run");
}

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-manager-library-"));
  configureLibraryStoreDir(path.join(dir, "data"));
  configureRunsDir(path.join(dir, "runs"));
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  configureRunsDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an installed skill and tool are seeded into the installer's run", async () => {
  const skill = addInstalledItem("installer", {
    kind: "skill",
    name: "Runbook",
    description: "Ops runbook",
    payload: {
      kind: "skill",
      skillMd: "# Runbook\n\nRead this before deploying.",
      files: [{ path: "scripts/check.sh", content: "echo checked" }],
      requiredFields: [],
    },
  });
  addInstalledItem("installer", {
    kind: "tool",
    name: "Counter",
    description: "Counts things",
    payload: {
      kind: "tool",
      language: "javascript",
      code: "return { count: (args && args.n) || 0 };",
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
      requiredFields: [],
      timeoutMs: 5000,
    },
  });

  const driver = new CapturingFakeVm();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver as VmDriver }), router: null });

  const started = manager.start("installer", { prompt: "do the thing" });
  assert.equal(started.accepted, true);
  const runs = await waitForDone(manager, "installer");
  assert.equal(runs[0].status, "finished");

  const skillPath = `/workspace/.claude/skills/${libraryServerName(skill.id)}/SKILL.md`;
  assert.equal(driver.peekFile("installer", skillPath), "# Runbook\n\nRead this before deploying.");
  assert.equal(driver.peekFile("installer", `/workspace/.claude/skills/${libraryServerName(skill.id)}/scripts/check.sh`), "echo checked");
  assert.match(driver.peekFile("installer", "/workspace/.swarm/library-tools.json") ?? "", /"Counts things"/);
  assert.match(driver.peekFile("installer", "/workspace/.swarm/library-tools-server.mjs") ?? "", /tools\/call/);

  const config = JSON.parse(driver.peekFile("installer", "/workspace/.swarm/mcp.json") ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  assert.ok(config.mcpServers?.[LIBRARY_TOOLS_SERVER_NAME], "custom tools server is in --mcp-config");
  assert.ok(config.mcpServers?.roles, "the role-switch server is still there");

  const argv = driver.claudeCalls[0] ?? [];
  const toolsIndex = argv.indexOf("--allowedTools");
  assert.ok(toolsIndex >= 0);
  const allowed = argv.slice(toolsIndex + 1, argv.indexOf("--mcp-config"));
  assert.ok(allowed.includes(`mcp__${LIBRARY_TOOLS_SERVER_NAME}__*`), "the run may call installed tools");
});

test("removed Library items are cleaned from a persistent VM without touching user or current item files", async () => {
  const removed = addInstalledItem("installer", {
    kind: "skill",
    name: "Removed runbook",
    payload: {
      kind: "skill",
      skillMd: "# Remove me",
      files: [{ path: "scripts/old.sh", content: "echo old" }],
      requiredFields: [],
    },
  });
  const kept = addInstalledItem("installer", {
    kind: "skill",
    name: "Current runbook",
    payload: {
      kind: "skill",
      skillMd: "# Keep me",
      files: [{ path: "scripts/current.sh", content: "echo current" }],
      requiredFields: [],
    },
  });
  const tool = addInstalledItem("installer", {
    kind: "tool",
    name: "Temporary tool",
    payload: {
      kind: "tool",
      language: "javascript",
      code: "return true;",
      inputSchema: { type: "object", properties: {} },
      requiredFields: [],
      timeoutMs: 5000,
    },
  });

  const driver = new CapturingFakeVm();
  const vm = new VmManager({ customDriver: driver as VmDriver });
  const manager = new RuntimeManager({ vm, router: null });
  const handle = await driver.ensure("installer");
  await driver.writeFile(handle, "/workspace/.claude/skills/lib-removed-legacy/SKILL.md", "# Legacy stale skill");
  await driver.writeFile(handle, "/workspace/.claude/skills/lib-removed-legacy/scripts/stale.sh", "echo stale");
  await driver.writeFile(handle, "/workspace/.claude/skills/user-runbook/SKILL.md", "# User skill");
  await driver.writeFile(handle, "/workspace/.swarm/user-note.txt", "keep swarm note");
  await driver.writeFile(handle, "/workspace/notes.txt", "keep workspace note");

  assert.equal(manager.start("installer", { prompt: "first run" }).accepted, true);
  await waitForDone(manager, "installer");

  const removedRoot = `/workspace/.claude/skills/${libraryServerName(removed.id)}`;
  const keptRoot = `/workspace/.claude/skills/${libraryServerName(kept.id)}`;
  assert.equal(driver.peekFile("installer", `${removedRoot}/SKILL.md`), "# Remove me");
  assert.equal(driver.peekFile("installer", "/workspace/.claude/skills/lib-removed-legacy/SKILL.md"), undefined);
  assert.equal(driver.peekFile("installer", "/workspace/.claude/skills/lib-removed-legacy/scripts/stale.sh"), undefined);
  await driver.writeFile(handle, `${keptRoot}/user-note.txt`, "keep current item note");

  assert.equal(deleteInstalledItem("installer", removed.id), true);
  assert.equal(deleteInstalledItem("installer", tool.id), true);
  assert.equal(manager.start("installer", { prompt: "second run" }).accepted, true);
  const runs = await waitForDone(manager, "installer");
  assert.ok(runs.every((run) => run.status === "finished"));

  assert.equal(driver.peekFile("installer", `${removedRoot}/SKILL.md`), undefined);
  assert.equal(driver.peekFile("installer", `${removedRoot}/scripts/old.sh`), undefined);
  assert.equal(driver.peekFile("installer", "/workspace/.swarm/library-tools.json"), undefined);
  assert.equal(driver.peekFile("installer", "/workspace/.swarm/library-tools-server.mjs"), undefined);

  assert.equal(driver.peekFile("installer", `${keptRoot}/SKILL.md`), "# Keep me");
  assert.equal(driver.peekFile("installer", `${keptRoot}/scripts/current.sh`), "echo current");
  assert.equal(driver.peekFile("installer", `${keptRoot}/user-note.txt`), "keep current item note");
  assert.equal(driver.peekFile("installer", "/workspace/.claude/skills/user-runbook/SKILL.md"), "# User skill");
  assert.equal(driver.peekFile("installer", "/workspace/.swarm/user-note.txt"), "keep swarm note");
  assert.equal(driver.peekFile("installer", "/workspace/notes.txt"), "keep workspace note");
});
