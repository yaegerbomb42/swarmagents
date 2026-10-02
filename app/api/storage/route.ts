import { scoped } from "@/lib/auth";
import { getMeta, listSessions } from "@/lib/store";
import { fmtMB, levelOf, storageLimit, usage } from "@/lib/tenant/storage";
import { chatBusy, clearOldChats, deleteChat, describePrune, getStorageSettings, maybeAutoPrune, pruneLog, pruneTo, PRUNE_AT, PRUNE_TO, saveStorageSettings } from "@/lib/tenant/prune";

export const dynamic = "force-dynamic";

/** What the Settings → Storage panel and the warning banner show. */
function report(fresh = false) {
  const u = usage(undefined, fresh);
  const limit = storageLimit();
  const finite = Number.isFinite(limit);
  const level = levelOf(u.used, limit);
  const settings = getStorageSettings();
  const pinned = new Set(settings.pinned);
  const chats = listSessions().map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt, bytes: u.sessions[m.id] ?? 0, pinned: pinned.has(m.id), busy: chatBusy(m) }));
  const pct = finite ? u.used / limit : 0;
  const message =
    level === "full"
      ? `Storage full: ${fmtMB(u.used)} of ${fmtMB(limit)}. New messages, runs and files are blocked until you free space. Delete old chats below or turn on auto-prune.`
      : level === "critical"
        ? `Storage almost full: ${Math.floor(pct * 100)}% of ${fmtMB(limit)} used. Delete old chats or turn on auto-prune before new work is blocked at 100%.`
        : level === "warn"
          ? `You've used ${Math.floor(pct * 100)}% of your ${fmtMB(limit)} storage. Consider deleting old chats or turning on auto-prune.`
          : null;
  return {
    limit: finite ? limit : null,
    used: u.used,
    pct,
    level,
    message,
    byCategory: u.byCategory,
    chats,
    settings,
    autoPrune: { startsAt: PRUNE_AT, target: PRUNE_TO },
    log: pruneLog().slice(0, 50),
  };
}

export const GET = scoped(async () => Response.json(report()));

/**
 * { autoPrune: boolean } | { pin: id, pinned: boolean } | { action: "clear-old", days } | { action: "prune-now" }
 * | { action: "delete", id }. These free or manage space, so they work even when storage is full.
 */
export const POST = scoped(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as { autoPrune?: unknown; pin?: unknown; pinned?: unknown; action?: unknown; days?: unknown; id?: unknown };
  const sid = (v: unknown) => (typeof v === "string" && /^[a-f0-9]{16}$/.test(v) ? v : null);

  if (typeof body.autoPrune === "boolean") {
    saveStorageSettings({ autoPrune: body.autoPrune });
    const pruned = body.autoPrune ? maybeAutoPrune(usage(undefined, true)) : [];
    return Response.json({ ...report(true), pruned, note: pruned.length ? describePrune(pruned) : undefined });
  }
  if (body.pin !== undefined) {
    const id = sid(body.pin);
    if (!id || !getMeta(id)) return Response.json({ error: "No such chat." }, { status: 404 });
    const cur = new Set(getStorageSettings().pinned);
    if (body.pinned === false) cur.delete(id);
    else cur.add(id);
    saveStorageSettings({ pinned: [...cur] });
    return Response.json(report());
  }
  switch (body.action) {
    case "clear-old": {
      const days = Number(body.days ?? 30);
      if (!Number.isFinite(days) || days < 0 || days > 3650) return Response.json({ error: "days must be 0–3650" }, { status: 400 });
      const pruned = clearOldChats(days);
      return Response.json({ ...report(true), pruned, note: describePrune(pruned) });
    }
    case "prune-now": {
      const limit = storageLimit();
      if (!Number.isFinite(limit)) return Response.json({ error: "No storage limit applies here." }, { status: 400 });
      const pruned = pruneTo(Math.floor(limit * PRUNE_TO), false);
      return Response.json({ ...report(true), pruned, note: describePrune(pruned) });
    }
    case "delete": {
      const id = sid(body.id);
      if (!id) return Response.json({ error: "No such chat." }, { status: 404 });
      const r = deleteChat(id);
      if ("error" in r) return Response.json({ error: r.error }, { status: r.status });
      return Response.json({ ...report(true), pruned: [r], note: describePrune([r]) });
    }
  }
  return Response.json({ error: "Unknown action." }, { status: 400 });
});
