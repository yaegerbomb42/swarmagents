import { scoped } from "@/lib/auth";
import { session, dropSession } from "@/lib/agent";
import { deleteSession } from "@/lib/store";
import type { Attachment, StreamOp } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Live event stream: a snapshot, then every add/patch as it happens. */
async function getHandler(req: Request, { params }: Ctx) {
  const s = session((await params).id);
  if (!s) return new Response("not found", { status: 404 });
  const enc = new TextEncoder();
  let sub: ((op: StreamOp) => void) | null = null;
  let ping: NodeJS.Timeout | null = null;
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (op: StreamOp) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(op)}\n\n`));
        } catch {}
      };
      send({ op: "snapshot", events: s.events, running: s.running, meta: s.meta, context: s.context });
      sub = send;
      s.subs.add(sub);
      ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 20_000);
      req.signal.addEventListener("abort", () => {
        if (sub) s.subs.delete(sub);
        if (ping) clearInterval(ping);
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      if (sub) s.subs.delete(sub);
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

async function postHandler(req: Request, { params }: Ctx) {
  const s = session((await params).id);
  if (!s) return new Response("not found", { status: 404 });
  const { text, attachments } = (await req.json()) as { text: string; attachments?: Attachment[] };
  s.send(text ?? "", attachments ?? []);
  return Response.json({ ok: true });
}

async function deleteHandler(_: Request, { params }: Ctx) {
  const id = (await params).id;
  // Resolves only within the caller's own data, so another account's session is simply not found.
  if (!session(id)) return new Response("not found", { status: 404 });
  dropSession(id);
  deleteSession(id);
  return Response.json({ ok: true });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const GET = scoped(getHandler);
export const POST = scoped(postHandler);
export const DELETE = scoped(deleteHandler);
