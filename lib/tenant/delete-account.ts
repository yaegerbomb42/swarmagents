// Admin "delete user" (deploy lane ask, 21:43): remove a non-admin account and everything it stored.
//
// Order matters so nothing half-deleted can come back:
//   1. delete the account row and every login session (its cookies stop working at once; sign-in fails);
//   2. inside that account's context, cancel its background tasks and stop its live chats;
//   3. on a sandboxed server, kill whatever its tools left running under its own OS uid;
//   4. remove its home directory (chats, files, keys, browser profile, runtime) and forget cached usage.
// The OS uid is never reused (the counter only goes up), so a later sign-up can't inherit leftovers.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listSessions, runAs, userHome } from "../store";
import { deleteUser } from "../users";
import { dropSession } from "../agent";
import { cancelTask, listTasks } from "../runtime/tasks";
import { invalidate, usage } from "./storage";

export type DeleteResult = { ok: true; username: string; freed: number; chats: number; tasks: number } | { ok: false; status: number; error: string };

export async function deleteAccount(id: string, byAdminId: string): Promise<DeleteResult> {
  if (!/^[a-f0-9]{16}$/.test(id)) return { ok: false, status: 404, error: "No such user." };
  if (id === byAdminId) return { ok: false, status: 409, error: "You can't delete your own account." };
  let freed = 0;
  try {
    freed = usage(id, true).used;
  } catch {}
  const row = deleteUser(id);
  if (!row) return { ok: false, status: 404, error: "No such user, or it is an admin (admins can't be deleted here)." };

  let chats = 0;
  let tasks = 0;
  await runAs(id, async () => {
    try {
      for (const t of listTasks()) {
        if (["queued", "running", "waiting", "blocked"].includes(t.status)) {
          await cancelTask(t.id).catch(() => null);
          tasks++;
        }
      }
    } catch {}
    try {
      for (const m of listSessions()) {
        dropSession(m.id);
        chats++;
      }
    } catch {}
  });

  // Leftover background processes of that account (servers with the per-user sandbox only).
  if (process.env.SWARM_SANDBOX === "uid" && row.osUid && row.osUid >= 20000) spawnSync("pkill", ["-KILL", "-u", String(row.osUid)], { stdio: "ignore", timeout: 5000 });

  // Give stopped loops a moment to unwind before their directory goes.
  await new Promise((r) => setTimeout(r, 300));
  const home = path.resolve(userHome(id));
  if (path.basename(path.dirname(home)) === "users") fs.rmSync(home, { recursive: true, force: true });
  invalidate(id);
  return { ok: true, username: row.username, freed, chats, tasks };
}
