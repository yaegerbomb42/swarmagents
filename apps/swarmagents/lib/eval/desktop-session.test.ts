// Desktop session for the live desktop eval (core-36): config shape and
// telemetry folding, plus real Xvfb runs that boot every desktop task's
// windows and prove the per-run code is actually readable on screen.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_ALLOWED_TOOLS,
  DESKTOP_DENIED_TOOLS,
  desktopMcpConfig,
  foldDesktopTelemetry,
  missingDesktopBinaries,
  startDesktopSession,
} from "./desktop-session";
import { DESKTOP_PROVIDER_EVAL_TASKS, DESKTOP_SECRET_CODE } from "./provider-tasks-desktop";

const missing = missingDesktopBinaries();
const skip = missing.length > 0 ? `needs ${missing.join(", ")}` : false;

test("desktopMcpConfig points computer-mcp at the display, text mode opt-in", () => {
  const cfg = desktopMcpConfig(":55", { serverPath: "/x/server.mjs" }) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  assert.deepEqual(Object.keys(cfg.mcpServers), ["computer-mcp"]);
  assert.equal(cfg.mcpServers["computer-mcp"].command, process.execPath);
  assert.deepEqual(cfg.mcpServers["computer-mcp"].args, ["/x/server.mjs"]);
  assert.deepEqual(cfg.mcpServers["computer-mcp"].env, { DISPLAY: ":55" });
  const text = desktopMcpConfig(":55", { textDesktop: true }) as typeof cfg;
  assert.equal(text.mcpServers["computer-mcp"].env.SWARM_TEXT_DESKTOP, "1");
});

test("only computer-mcp is allowed and every shell/file tool is denied", () => {
  assert.deepEqual(DESKTOP_ALLOWED_TOOLS, ["mcp__computer-mcp"]);
  for (const tool of ["Bash", "Write", "Edit", "Read", "Glob", "Grep", "Task"]) assert.ok(DESKTOP_DENIED_TOOLS.includes(tool), tool);
});

test("foldDesktopTelemetry counts computer actions, no-change effects and loop nudges", () => {
  const m = foldDesktopTelemetry([
    { type: "tool.call", name: "mcp__computer-mcp__click" },
    { type: "tool.result", output: "Clicked\neffect: NO visible change after 1.0s; focused window unchanged" },
    { type: "tool.call", name: "mcp__computer-mcp__type" },
    { type: "tool.result", output: "Typed\neffect: screen changed" },
    { type: "tool.call", name: "Bash" },
    { type: "watchdog.loop", action: "nudge" },
    { type: "watchdog.loop", action: "escalate" },
  ]);
  assert.deepEqual(m, { computerActions: 2, noChangeEffects: 1, loopNudges: 1 });
});

async function workspaceFor(t: { after: (fn: () => Promise<void>) => void }, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-desktop-session-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

for (const task of DESKTOP_PROVIDER_EVAL_TASKS) {
  test(`${task.id}: its windows come up on a fresh display and are torn down`, { skip }, async (t) => {
    const dir = await workspaceFor(t, task.setupFiles);
    const session = await startDesktopSession(task.desktop!, dir);
    const env = { ...process.env, DISPLAY: session.display };
    try {
      for (const app of task.desktop!.apps) {
        const found = spawnSync("xdotool", ["search", "--name", `^${app.waitForTitle}$`], { env, timeout: 5_000 });
        assert.equal(found.status, 0, `window ${app.waitForTitle}`);
      }
    } finally {
      await session.stop();
    }
    assert.equal(existsSync(`/tmp/.X${session.display.slice(1)}-lock`), false);
  });
}

test(
  "the per-run code is legible on screen (OCR of a real screenshot)",
  { skip: skip || (spawnSync("which", ["tesseract"]).status !== 0 ? "needs tesseract" : false) },
  async (t) => {
    const task = DESKTOP_PROVIDER_EVAL_TASKS.find((x) => x.id === "desktop-read-code-from-screen")!;
    const dir = await workspaceFor(t, task.setupFiles);
    const session = await startDesktopSession(task.desktop!, dir);
    try {
      const shot = path.join(dir, "shot.png");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(spawnSync("scrot", ["-o", shot], { env: { ...process.env, DISPLAY: session.display }, timeout: 10_000 }).status, 0);
      const ocr = spawnSync("tesseract", [shot, "-"], { encoding: "utf8" }).stdout.replace(/\s+/g, "");
      assert.ok(ocr.includes(DESKTOP_SECRET_CODE.replace(/\s+/g, "")), `OCR saw: ${ocr.slice(0, 200)}`);
    } finally {
      await session.stop();
    }
  },
);
