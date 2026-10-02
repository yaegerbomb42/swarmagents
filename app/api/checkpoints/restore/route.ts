import { scoped } from "@/lib/auth";
import { restoreCheckpoint } from "@/lib/tools/files";

/** Undo a file edit: restore the pre-edit snapshot. Body: { checkpoint, session? }.
 *  `session` scopes the lookup to that task's snapshots (the UI always knows it);
 *  without it we still search this server's checkpoint dirs, because ids are random
 *  per snapshot and only one dir can hold a given id in practice. */
async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { checkpoint?: string; session?: string };
  const checkpoint = body.checkpoint ?? "";
  const session = body.session ?? "";
  if (!checkpoint || !/^[a-f0-9]+$/.test(checkpoint)) return new Response("bad checkpoint", { status: 400 });
  // Enter a session-scoped request only through the session-id format the store enforces.
  if (session && !/^[a-f0-9]{16}$/.test(session)) return new Response("bad session", { status: 400 });
  const { getMeta, userHome } = await import("@/lib/store");
  // Only this user's tasks: getMeta resolves inside the caller's own data, so another account's session is unknown.
  if (session && !getMeta(session)) return new Response("checkpoint not found", { status: 404 });
  if (!session && process.env.SWARM_MODE === "server") return new Response("session required", { status: 400 });
  const fs = await import("node:fs");
  const path = await import("node:path");
  const base = path.join(userHome(), "checkpoints");
  let sessions: string[];
  if (session) {
    sessions = [session];
  } else {
    try {
      sessions = fs.readdirSync(base);
    } catch {
      return new Response("checkpoint not found", { status: 404 });
    }
  }
  for (const s of sessions) {
    const r = restoreCheckpoint(s, checkpoint);
    if (r.ok) return Response.json({ ok: true, message: r.message });
  }
  return new Response("checkpoint not found", { status: 404 });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const POST = scoped(postHandler);
