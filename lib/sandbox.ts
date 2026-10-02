// Per-user OS isolation for everything the agent executes (layer 3 of multi-user).
//
// On a server each account's tool processes (shell, MCP stdio servers, Chromium) run as that account's own uid
// (lib/users osUid), with no supplementary groups, no capabilities and no-new-privs. Only its workspace belongs to
// that uid (0700). The home around it stays root-owned and traversable but not listable (0711), so the agent can't
// swap server-managed files (settings with keys, session logs) for symlinks into another account. Other accounts'
// data, auth.db (root, 0600) and /proc/<server pid>/environ are unreadable to it. The server process itself runs
// as root holding only the capabilities needed to do this (Dockerfile / compose: SETUID, SETGID, CHOWN, FOWNER,
// DAC_OVERRIDE).
//
// In-process tools (read/write/edit file, search) don't change uid, so they must check paths with
// assertInsideHome(), which resolves symlinks the sandboxed shell might have planted.
//
// Locally (no SWARM_MODE=server) none of this applies: tools run as the person at the keyboard, as before.
// On a server without SWARM_SANDBOX=uid, tools refuse to run rather than run unisolated.

import fs from "node:fs";
import path from "node:path";
import { ROOT, browserProfile, currentUser, uploadsDir, userHome } from "./store";
import { osUid } from "./users";

export const serverMode = () => process.env.SWARM_MODE === "server";
const enabled = () => process.env.SWARM_SANDBOX === "uid";
const SETPRIV = process.env.SWARM_SETPRIV ?? "/usr/bin/setpriv";

export class SandboxUnavailableError extends Error {
  constructor() {
    super("Tools are disabled: this server runs in multi-user mode without the per-user sandbox (SWARM_SANDBOX=uid).");
  }
}

export interface Identity {
  uid: number;
  gid: number;
  home: string;
  workspace: string;
}

const prepared = new Set<string>();

/** Make `dir` exist with this owner and mode. Idempotent; cheap after the first call per directory. */
function prepareDir(dir: string, uid: number, mode: number) {
  const k = `${dir}:${uid}:${mode}`;
  if (prepared.has(k)) return;
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chownSync(dir, uid, uid);
  fs.chmodSync(dir, mode);
  prepared.add(k);
}

/** Create (or confirm) a directory owned by the current user's sandbox uid, so their tools can write
 *  into it. On a server the server process is root, so any dir it makes under the workspace must be
 *  handed to the uid; locally this is a plain mkdir. Returns the path. Ancestors up to the workspace
 *  are kept traversable and root-owned. */
export function sandboxDir(dir: string): string {
  const id = identity();
  if (!id) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const abs = path.resolve(dir);
  const { workspace } = id;
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) throw new Error("sandboxDir outside the workspace");
  for (let d = abs; d !== workspace && d !== path.dirname(d); d = path.dirname(d)) prepareDir(d, id.uid, 0o700);
  return abs;
}

/** Who the current user's tool processes run as, or null when tools run unsandboxed (local mode). */
export function identity(): Identity | null {
  if (!serverMode()) return null;
  if (!enabled()) throw new SandboxUnavailableError();
  const uid = osUid(currentUser());
  const home = userHome();
  // Root-owned path down to the workspace: traversable (so the uid can reach its workspace), never listable.
  for (const d of [ROOT, path.dirname(home), home]) prepareDir(d, 0, 0o711);
  const workspace = path.join(home, "workspace");
  prepareDir(workspace, uid, 0o700);
  return { uid, gid: uid, home, workspace };
}

/** Wrap a command so it runs as the current user's uid. Locally it is returned unchanged. */
export function sandboxCommand(command: string, args: string[]): { command: string; args: string[] } {
  const id = identity();
  if (!id) return { command, args };
  return {
    command: SETPRIV,
    args: [`--reuid=${id.uid}`, `--regid=${id.gid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--", command, ...args],
  };
}

/** Environment overrides for a sandboxed process: its own HOME, never the server's. */
export function sandboxEnv(): Record<string, string> {
  const id = identity();
  if (!id) return {};
  return { HOME: id.workspace, USER: `u${id.uid}`, LOGNAME: `u${id.uid}`, TMPDIR: path.join(id.workspace, ".tmp") };
}

/** Hand a server-written file (an upload, a download) to the current user, so its sandboxed tools can use it. */
export function giveToUser(file: string) {
  const id = identity();
  if (!id) return;
  fs.chownSync(file, id.uid, id.gid);
}

/** After the server (root) created `file`, and possibly parent dirs starting at `firstCreated`, give them to the user. */
export function giveCreated(file: string, firstCreated?: string) {
  const id = identity();
  if (!id) return;
  if (firstCreated)
    for (let d = path.dirname(file); ; d = path.dirname(d)) {
      fs.chownSync(d, id.uid, id.gid);
      if (d === firstCreated || d === path.dirname(d)) break;
    }
  fs.chownSync(file, id.uid, id.gid);
}

/**
 * How to launch Chromium for the current user. On a server: through bin/swarm-chromium, which drops to the user's
 * uid before exec'ing the real browser, with the profile inside the user's workspace (owned by that uid). Locally:
 * the configured executable and the usual profile. Browser launchers must use this and never fall back to an
 * unwrapped launch on a server.
 */
export function chromiumLaunch(realExe?: string): { executablePath?: string; env: Record<string, string>; profileRoot: string } {
  const id = identity();
  if (!id) return { executablePath: realExe, env: {}, profileRoot: browserProfile() };
  return {
    executablePath: process.env.SWARM_CHROMIUM_WRAPPER ?? "/usr/local/bin/swarm-chromium",
    env: { SWARM_RUN_UID: String(id.uid), SWARM_CHROME_REAL: realExe ?? "/usr/bin/chromium", HOME: id.workspace },
    profileRoot: path.join(id.workspace, ".browser"),
  };
}

/** Where a new task starts: the user's workspace on a server, the person's home directory locally. */
export function defaultCwd(fallback: string) {
  return identity()?.workspace ?? fallback;
}

/**
 * For tools that run inside the server process (as root): refuse any path outside the current user's workspace
 * and uploads, after resolving symlinks the sandboxed shell may have planted (for paths that don't exist yet,
 * via the nearest existing parent). Locally every path is allowed.
 */
export function assertInsideHome(p: string): string {
  const abs = path.resolve(p);
  if (!serverMode()) return abs;
  const roots = [fs.realpathSync(identity()!.workspace), fs.realpathSync(uploadsDir())];
  const inside = (full: string) => roots.some((r) => full === r || full.startsWith(r + path.sep));
  let probe = abs;
  let rest = "";
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const full = rest ? path.join(real, rest) : real;
      if (!inside(full)) throw new Error(`Access denied: ${p} is outside your workspace.`);
      return full;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`Access denied: ${p} is outside your workspace.`);
      rest = rest ? path.join(path.basename(probe), rest) : path.basename(probe);
      probe = parent;
    }
  }
}
