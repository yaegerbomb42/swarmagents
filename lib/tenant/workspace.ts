// Per-user workspace and path confinement.
//
// Locally (one user, "local") nothing changes: tools see the whole Mac and ~ is the user's home. On a server each
// account works in SWARM_HOME/users/<id>/workspace, and every in-process file tool (read/write/edit/list, uploads,
// previews, downloads) must resolve its path through confinePath(). These tools run inside the server process, so
// the OS sandbox (lib/sandbox.ts, deploy lane) can't protect them: the realpath check here is the only barrier
// between one account's agent and another account's data, auth.db, or the server's own files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentUser, uploadsDir, userHome } from "../store";

const isLocal = (user: string) => user === "local";

/** The user's working directory: users/<id>/workspace on a server, the home directory locally. */
export function workspaceDir(userId = currentUser()): string {
  if (isLocal(userId)) return os.homedir();
  const d = path.join(userHome(userId), "workspace");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export class ConfinementError extends Error {
  constructor(p: string, root: string) {
    super(`"${p}" is outside your workspace. Work inside ${root} (it is your home directory here).`);
    this.name = "ConfinementError";
  }
}

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-attached (for files about to be created). */
function realish(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** The roots a user's tools may touch: the workspace (read/write) and their uploads (read only). */
export function allowedRoots(opts: { write?: boolean } = {}, userId = currentUser()): string[] {
  const roots = [workspaceDir(userId)];
  if (!opts.write) roots.push(uploadsDir());
  return roots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return r;
    }
  });
}

/**
 * Resolve a tool-supplied path for the current user. Locally: plain resolution against cwd, with ~ = home.
 * On a server: ~ is the workspace, and the realpath (symlinks followed) must stay inside the workspace (or the
 * user's uploads, for reads). Returns the resolved real path; throws ConfinementError otherwise.
 */
export function confinePath(p: string, cwd: string, opts: { write?: boolean } = {}): string {
  const user = currentUser();
  const home = workspaceDir(user);
  const abs = path.resolve(isLocal(user) ? cwd : safeCwd(cwd), String(p ?? "").replace(/^~(?=$|\/)/, home));
  if (isLocal(user)) return abs;
  const real = realish(abs);
  if (!allowedRoots(opts, user).some((r) => inside(real, r))) throw new ConfinementError(String(p), home);
  return real;
}

/** A cwd for the current user: unchanged locally; on a server, the given dir if it is inside the workspace, else the workspace. */
export function safeCwd(cwd: string | undefined): string {
  const user = currentUser();
  const home = workspaceDir(user);
  if (isLocal(user)) return cwd || home;
  if (!cwd) return home;
  const real = realish(path.resolve(home, cwd));
  return inside(real, fs.realpathSync(home)) ? real : home;
}

/** True if this absolute path belongs to the current user's allowed area (always true locally). */
export function isConfined(p: string, opts: { write?: boolean } = {}): boolean {
  const user = currentUser();
  if (isLocal(user)) return true;
  const real = realish(path.resolve(p));
  return allowedRoots(opts, user).some((r) => inside(real, r));
}
