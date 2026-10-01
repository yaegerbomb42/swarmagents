import { restoreCheckpoint } from "@/lib/tools/files";

/** Undo a file edit: restore the pre-edit snapshot. Body: { checkpoint }.
 *  Scoped to the checkpoint's own session dir would be ideal; the id is random
 *  per snapshot so we search this server's checkpoint dirs for it. */
export async function POST(req: Request) {
  const { checkpoint } = (await req.json().catch(() => ({}))) as { checkpoint?: string };
  if (!checkpoint || !/^[a-f0-9]+$/.test(checkpoint)) return new Response("bad checkpoint", { status: 400 });
  const { HOME } = await import("@/lib/store");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const base = path.join(HOME, "checkpoints");
  let sessions: string[] = [];
  try {
    sessions = fs.readdirSync(base);
  } catch {
    return new Response("checkpoint not found", { status: 404 });
  }
  for (const s of sessions) {
    const r = restoreCheckpoint(s, checkpoint);
    if (r.ok) return Response.json({ ok: true, message: r.message });
  }
  return new Response("checkpoint not found", { status: 404 });
}
