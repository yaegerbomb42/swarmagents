import { requestUser } from "@/lib/auth";
import { setUserQuota, userById } from "@/lib/users";
import { invalidate, MB } from "@/lib/tenant/storage";
import { deleteAccount } from "@/lib/tenant/delete-account";

export const dynamic = "force-dynamic";

/**
 * Admin only:
 *   { userId, quotaMB }                          change one account's storage quota (null = back to the role default)
 *   { userId, action: "delete", confirm: name }  delete a non-admin account and all its data (confirm = its username)
 */
export async function POST(req: Request) {
  const me = requestUser(req);
  if (!me?.isAdmin) return Response.json({ error: "Admins only." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; quotaMB?: unknown; action?: unknown; confirm?: unknown };
  const id = typeof body.userId === "string" ? body.userId : "";
  if (body.action === "delete") {
    const row = /^[a-f0-9]{16}$/.test(id) ? userById(id) : null;
    if (!row) return Response.json({ error: "No such user." }, { status: 404 });
    if (row.isAdmin) return Response.json({ error: "Admins can't be deleted here." }, { status: 409 });
    if (typeof body.confirm !== "string" || body.confirm.toLowerCase() !== row.username.toLowerCase())
      return Response.json({ error: `Type the username (${row.username}) to confirm.` }, { status: 400 });
    const r = await deleteAccount(id, me.id);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    console.log(`[admin] ${me.username} deleted account ${r.username} (${id}): ${r.chats} chats, ${r.tasks} tasks stopped, ${r.freed} bytes freed`);
    return Response.json(r);
  }
  if (!/^[a-f0-9]{16}$/.test(id) || !userById(id)) return Response.json({ error: "No such user." }, { status: 404 });
  let bytes: number | null = null;
  if (body.quotaMB !== null && body.quotaMB !== undefined) {
    const mb = Number(body.quotaMB);
    if (!Number.isFinite(mb) || mb < 1 || mb > 1024 * 1024) return Response.json({ error: "quotaMB must be 1–1048576, or null for the default." }, { status: 400 });
    bytes = Math.round(mb * MB);
  }
  setUserQuota(id, bytes);
  invalidate(id);
  return Response.json({ ok: true, userId: id, quotaBytes: bytes });
}
