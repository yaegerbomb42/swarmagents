import { scoped } from "@/lib/auth";
import { getMeta, loadArchivedEvents } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Page through archived (older) events: GET ?before=<index>&limit=<n>, newest page first. */
async function getHandler(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const meta = /^[a-f0-9]{16}$/.test(id) ? getMeta(id) : null;
  if (!meta) return new Response("not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const total = meta.archivedEvents ?? 0;
  const before = Math.min(total, Math.max(0, Number(q.get("before") ?? total) || 0));
  const limit = Math.min(1000, Math.max(1, Number(q.get("limit") ?? 300) || 300));
  const events = loadArchivedEvents(id, before, limit, total);
  return Response.json({ events, start: before - events.length, total });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const GET = scoped(getHandler);
