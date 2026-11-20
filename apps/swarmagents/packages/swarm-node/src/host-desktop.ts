/**
 * Host-mode desktop for the runner.
 *
 * With --host-mode there is no container, so the desktop is the machine's
 * own X server. When a headless one is needed (CI, a server, a laptop with
 * no session) this module starts the classic trio:
 *
 *   Xvfb        — the virtual framebuffer (the "screen")
 *   x11vnc      — the VNC server for that display
 *   websockify  — the websocket front end the tunnel relays
 *
 * Everything listens on loopback only. When the tools are not installed the
 * node simply reports "no desktop" and keeps working headless.
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodeHostDesktop } from "./backend";

export interface HostDesktopOptions {
  /** X display number (default 99). */
  display?: number;
  /** Framebuffer size. */
  width?: number;
  height?: number;
  /** VNC password (empty means no password). */
  password?: string;
  /** Where the password file is written (default: a temp file). */
  stateDir?: string;
}

/** True when a binary can be found in PATH. */
export function hasBinary(name: string): boolean {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Ask the OS for a free TCP port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startProcess(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: "ignore", detached: false });
  // A failed spawn must never take the runner down with it.
  child.on("error", () => undefined);
  child.unref();
  return child;
}

/**
 * Find an X display number nobody uses yet: a leftover X server on the same
 * display would silently steal the screen.
 */
async function freeDisplayNumber(): Promise<number> {
  for (let candidate = 90; candidate < 200; candidate++) {
    const lock = path.join(os.tmpdir(), `.X${candidate}-lock`);
    if (fs.existsSync(lock)) continue;
    return candidate;
  }
  return 90 + (process.pid % 50);
}

/** Wait until something accepts TCP connections on a port. */
async function waitForPort(port: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Start a headless desktop (Xvfb + x11vnc + websockify).
 *
 * Returns null when the tools are missing or the desktop cannot start.
 */
export async function startHostDesktop(
  opts: HostDesktopOptions = {},
): Promise<NodeHostDesktop | null> {
  if (!hasBinary("Xvfb") || !hasBinary("x11vnc") || !hasBinary("websockify")) return null;

  const display = opts.display ?? (await freeDisplayNumber());
  const width = opts.width ?? 1600;
  const height = opts.height ?? 900;
  const stateDir = opts.stateDir ?? path.join(os.tmpdir(), `swarm-node-display-${process.pid}`);
  fs.mkdirSync(stateDir, { recursive: true });

  const children: ChildProcess[] = [];
  const cleanup = async () => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };

  try {
    children.push(
      startProcess("Xvfb", [`:${display}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"]),
    );
    // Give the X server a moment to come up.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const vncPort = await freePort();
    const vncArgs = [
      "-display",
      `:${display}`,
      "-rfbport",
      String(vncPort),
      "-localhost",
      "-forever",
      "-shared",
      "-quiet",
    ];
    if (opts.password) {
      const passFile = path.join(stateDir, "vnc.pass");
      await new Promise<void>((resolve, reject) => {
        const store = spawn("x11vnc", ["-storepasswd", opts.password as string, passFile], {
          stdio: "ignore",
        });
        store.on("error", reject);
        store.on("close", (code) => (code === 0 ? resolve() : reject(new Error("x11vnc -storepasswd failed"))));
      });
      vncArgs.push("-rfbauth", passFile);
    } else {
      vncArgs.push("-nopw");
    }
    children.push(startProcess("x11vnc", vncArgs));
    await new Promise((resolve) => setTimeout(resolve, 700));

    const webPort = await freePort();
    children.push(startProcess("websockify", [String(webPort), `127.0.0.1:${vncPort}`]));
    // The websocket front end has to be accepting connections before the
    // node reports the desktop as ready.
    if (!(await waitForPort(webPort))) {
      await cleanup();
      return null;
    }

    return {
      url: `ws://127.0.0.1:${webPort}/websockify`,
      password: opts.password ?? "",
      stop: cleanup,
    };
  } catch {
    await cleanup();
    return null;
  }
}
