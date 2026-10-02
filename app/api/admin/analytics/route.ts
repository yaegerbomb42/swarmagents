import { requestUser } from "@/lib/auth";
import { allUserIds, listSessions, runAs } from "@/lib/store";
import { listAccounts } from "@/lib/users";
import { listTasks } from "@/lib/runtime";
import { storageLimit, usage } from "@/lib/tenant/storage";

export const dynamic = "force-dynamic";

const LIVE_MS = 5 * 60_000;
const DAYS = 30;

/** Admin-only Analytics: live users, sign-ups (total and per day), running agent work, storage per user. */
export async function GET(req: Request) {
  const me = requestUser(req);
  if (!me?.isAdmin) return Response.json({ error: "Admins only." }, { status: 403 });
  const now = Date.now();
  const accounts = listAccounts();
  const known = new Set(allUserIds());

  // YYYY-MM-DD in the admin's zone (SWARM_TZ, default America/Chicago), not the container's UTC.
  const timeZone = process.env.SWARM_TZ || "America/Chicago";
  const day = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone });
  const perDay = new Map<string, number>();
  for (let i = DAYS - 1; i >= 0; i--) perDay.set(day(now - i * 86_400_000), 0);
  for (const a of accounts) {
    const d = day(a.createdAt);
    if (perDay.has(d)) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }

  let tasksRunning = 0;
  let tasksQueued = 0;
  let chatsRunning = 0;
  let storageTotal = 0;
  const users = accounts.map((a) => {
    let running = 0;
    let queued = 0;
    let chats = 0;
    let used = 0;
    if (known.has(a.id))
      runAs(a.id, () => {
        try {
          for (const t of listTasks()) {
            if (t.status === "running") running++;
            else if (t.status === "queued" || t.status === "waiting") queued++;
          }
        } catch {}
        try {
          chats = listSessions().filter((m) => m.active).length;
        } catch {}
        used = usage(a.id).used;
      });
    tasksRunning += running;
    tasksQueued += queued;
    chatsRunning += chats;
    storageTotal += used;
    const limit = storageLimit(a.id);
    return {
      id: a.id,
      username: a.username,
      email: a.email,
      isAdmin: a.isAdmin,
      disabled: a.disabled,
      createdAt: a.createdAt,
      lastSeenAt: a.lastSeenAt,
      live: !!a.lastSeenAt && now - a.lastSeenAt < LIVE_MS,
      tasksRunning: running,
      tasksQueued: queued,
      chatsRunning: chats,
      storage: { used, limit: Number.isFinite(limit) ? limit : null, custom: a.quotaBytes != null },
    };
  });

  return Response.json({
    at: now,
    liveUsers: users.filter((u) => u.live).length,
    liveWindowMin: LIVE_MS / 60_000,
    totalSignups: accounts.length,
    signupsPerDay: [...perDay].map(([date, n]) => ({ date, n })),
    running: { tasks: tasksRunning, queued: tasksQueued, chats: chatsRunning },
    storage: { total: storageTotal },
    users,
  });
}
