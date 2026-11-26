// A throwaway X desktop for live desktop eval tasks (core-36).
//
// Each trial gets its own Xvfb display (random :NN, no TCP listener) and the
// task's setup windows, launched with HOME and cwd inside the trial
// workspace so anything the agent does through the GUI lands in the graded
// directory. The agent reaches the desktop only through the repo's
// computer-mcp server (vm-image-desktop/computer-mcp/server.mjs) — the same
// server the A1 desktop VM ships — so the eval measures the real tool surface.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/** A window the task needs on screen before the agent starts. */
export interface DesktopApp {
  /** argv; never a shell string. `{HOME}` in any element is replaced with the workspace. */
  cmd: string[];
  /** Working directory relative to the workspace (default: the workspace). */
  cwd?: string;
  /** Wait until a window with this exact title exists. */
  waitForTitle?: string;
}

export interface DesktopSetup {
  apps: DesktopApp[];
  /** Screen geometry, default 1280x800. */
  width?: number;
  height?: number;
  /** Start xfwm4 when installed (default true). */
  windowManager?: boolean;
}

/** Binaries a desktop task needs on the host. */
export const DESKTOP_BINARIES = ["Xvfb", "xdotool", "scrot", "convert", "xterm"] as const;

export function missingDesktopBinaries(): string[] {
  return DESKTOP_BINARIES.filter((b) => spawnSync("which", [b], { stdio: "ignore" }).status !== 0);
}

/** Absolute path of the repo's computer-mcp server. */
export function computerMcpServerPath(appRoot = process.cwd()): string {
  return path.join(appRoot, "vm-image-desktop", "computer-mcp", "server.mjs");
}

/** --mcp-config JSON wiring computer-mcp to this display. */
export function desktopMcpConfig(
  display: string,
  opts: { serverPath?: string; textDesktop?: boolean } = {},
): Record<string, unknown> {
  return {
    mcpServers: {
      "computer-mcp": {
        type: "stdio",
        command: process.execPath,
        args: [opts.serverPath ?? computerMcpServerPath()],
        env: { DISPLAY: display, ...(opts.textDesktop ? { SWARM_TEXT_DESKTOP: "1" } : {}) },
      },
    },
  };
}

/** Tool permission strings for a GUI-only agent (no shell, no file tools). */
export const DESKTOP_ALLOWED_TOOLS = ["mcp__computer-mcp"];
export const DESKTOP_DENIED_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task"];

export interface DesktopSession {
  display: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function xenv(display: string, home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: display, HOME: home, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv;
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`desktop session: timed out waiting for ${what}`);
}

/** Boot Xvfb + the task's windows. Always call stop(). */
export async function startDesktopSession(setup: DesktopSetup, workspaceDir: string): Promise<DesktopSession> {
  const procs: ChildProcess[] = [];
  let display = "";
  for (let attempt = 0; attempt < 10 && !display; attempt++) {
    const n = 40 + Math.floor(Math.random() * 50);
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    display = `:${n}`;
  }
  if (!display) throw new Error("desktop session: no free X display");
  const signal = (p: ChildProcess, sig: NodeJS.Signals) => {
    try {
      if (p.pid !== undefined) process.kill(-p.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const stop = async () => {
    // SIGTERM first so Xvfb removes its lock and socket; SIGKILL stragglers.
    const live = procs.reverse().filter((p) => p.exitCode === null && p.signalCode === null);
    for (const p of live) signal(p, "SIGTERM");
    await Promise.race([
      Promise.all(live.map((p) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.once("exit", r))))),
      sleep(2_000),
    ]);
    for (const p of live) signal(p, "SIGKILL");
    const n = display.slice(1);
    for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) rmSync(f, { force: true });
  };
  try {
    const geometry = `${setup.width ?? 1280}x${setup.height ?? 800}x24`;
    procs.push(spawn("Xvfb", [display, "-screen", "0", geometry, "-nolisten", "tcp"], { stdio: "ignore", detached: true }));
    const env = xenv(display, workspaceDir);
    await waitFor(() => spawnSync("xdotool", ["getmouselocation"], { env, stdio: "ignore", timeout: 2_000 }).status === 0, 10_000, "Xvfb");
    // A window manager makes focus_window / windowactivate work like on the
    // real A1 image (xfce). Optional: bare Xvfb still runs, focus follows the pointer.
    if (setup.windowManager !== false && spawnSync("which", ["xfwm4"], { stdio: "ignore" }).status === 0) {
      procs.push(spawn("xfwm4", ["--compositor=off"], { env, stdio: "ignore", detached: true }));
      await sleep(400);
    }
    for (const app of setup.apps) {
      const argv = app.cmd.map((a) => a.split("{HOME}").join(workspaceDir));
      const cwd = app.cwd ? path.join(workspaceDir, app.cwd) : workspaceDir;
      procs.push(spawn(argv[0], argv.slice(1), { cwd, env, stdio: "ignore", detached: true }));
      if (app.waitForTitle) {
        const title = app.waitForTitle;
        await waitFor(
          () => spawnSync("xdotool", ["search", "--name", `^${title}$`], { env, stdio: "ignore", timeout: 2_000 }).status === 0,
          10_000,
          `window "${title}"`,
        );
      }
    }
    await sleep(500); // let the windows paint
    return { display, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Per-trial desktop counters folded from the runner's telemetry. */
export interface DesktopRunMetrics {
  computerActions: number;
  noChangeEffects: number;
  loopNudges: number;
}

export function foldDesktopTelemetry(
  events: ReadonlyArray<{ type: string; name?: unknown; output?: unknown; action?: unknown }>,
): DesktopRunMetrics {
  let computerActions = 0;
  let noChangeEffects = 0;
  let loopNudges = 0;
  for (const e of events) {
    if (e.type === "tool.call" && typeof e.name === "string" && e.name.startsWith("mcp__computer-mcp__")) computerActions += 1;
    if (e.type === "tool.result" && typeof e.output === "string" && e.output.includes("effect: NO visible change")) noChangeEffects += 1;
    if (e.type === "watchdog.loop" && e.action === "nudge") loopNudges += 1;
  }
  return { computerActions, noChangeEffects, loopNudges };
}
