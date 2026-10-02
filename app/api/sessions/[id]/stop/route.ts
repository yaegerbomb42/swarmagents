import { scoped } from "@/lib/auth";
import { session } from "@/lib/agent";
import { scheduler, taskForSession } from "@/lib/runtime";

async function postHandler(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const s = session(id);
  if (!s) return new Response("not found", { status: 404 });
  // A task run drives a normal session. Stopping the session alone would let the scheduler's run
  // settle as "done", so route through the scheduler: it aborts the run, records it interrupted, and
  // clears the task from the registry so it can be resumed. Interactive chat has no task and simply
  // stops the session.
  const task = taskForSession(id);
  let settled = true;
  if (task) settled = await scheduler().stopTask(task.id);
  else s.stop();
  return Response.json({ ok: true, taskId: task?.id ?? null, settled });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const POST = scoped(postHandler);
