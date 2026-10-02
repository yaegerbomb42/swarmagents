import { scoped } from "@/lib/auth";
import { session } from "@/lib/agent";
import { browserRuntime, dispatchInput, parseInput, type ControlCommand } from "@/lib/browser";

export const dynamic = "force-dynamic";

// Viewer control plane for a live browser: status, take-over/hand-back, pause, stop, and the raw
// mouse/keyboard events the user generates while in control.
//
// Auth: scoped() resolves the signed-in user; the task is looked up in their own store, so only the
// owner of a task can watch or drive its browser. Input is accepted only while the user holds
// control ("take over"), never while the agent is driving.

/** The user may only act on a task they own. */
function ownedBy(sid: string) {
  return !!sid && !!session(sid);
}

async function getHandler(req: Request) {
  const url = new URL(req.url);
  const sid = url.searchParams.get("session");
  const rt = browserRuntime();
  if (sid) {
    if (!ownedBy(sid)) return Response.json({ error: "No such task." }, { status: 404 });
    const s = rt.get(sid);
    return Response.json({ status: s ? s.status() : { key: sid, live: false }, replay: s ? rt.replay(sid).length : 0 });
  }
  // No session requested: the grid view asks for every live browser on this account. Live sessions
  // are keyed by task id, so filter to the tasks this user can actually see.
  const live = rt.list().filter((s) => ownedBy(s.key));
  return Response.json({ statuses: live });
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    session?: string;
    cmd?: ControlCommand;
    input?: unknown;
    takeOver?: boolean;
    handBack?: boolean;
  };
  const sid = String(body.session ?? "");
  if (!ownedBy(sid)) return Response.json({ error: "No such task." }, { status: 404 });
  const rt = browserRuntime();
  const s = rt.get(sid);
  if (!s) return Response.json({ error: "No live browser for this task." }, { status: 409 });

  if (body.input) {
    if (s.controller !== "user") return Response.json({ error: "Take over first." }, { status: 409 });
    const input = parseInput(body.input);
    if (!input) return Response.json({ error: "Unrecognised input event." }, { status: 400 });
    const ok = await dispatchInput(s, input);
    return Response.json({ ok, status: s.status() });
  }

  const cmd: ControlCommand = { ...(body.cmd ?? {}) };
  if (body.takeOver) cmd.controller = "user";
  if (body.handBack) cmd.controller = "agent";
  const res = await rt.control(sid, cmd);
  return Response.json(res.ok ? { ok: true, status: res.status } : { error: res.error }, { status: res.ok ? 200 : 409 });
}

export const GET = scoped(getHandler);
export const POST = scoped(postHandler);