import { requestUser } from "@/lib/auth";
import { setUserQuota, userById } from "@/lib/users";
import { invalidate, MB } from "@/lib/tenant/storage";

export const dynamic = "force-dynamic";

/** Admin: change one account's storage quota. { userId, quotaMB } (null = back to the role default). */
export async function POST(req: Request) {
  const me = requestUser(req);
  if (!me?.isAdmin) return Response.json({ error: "Admins only." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; quotaMB?: unknown };
  const id = typeof body.userId === "string" ? body.userId : "";
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
