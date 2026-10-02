import { scoped } from "@/lib/auth";
import { session } from "@/lib/agent";

async function postHandler(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = session((await params).id);
  if (!s) return new Response("not found", { status: 404 });
  s.stop();
  return Response.json({ ok: true });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const POST = scoped(postHandler);
