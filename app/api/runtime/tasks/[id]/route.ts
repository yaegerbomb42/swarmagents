import {
  cancelTask,
  deleteTask,
  getLedger,
  getTask,
  listArtifacts,
  progressOf,
  scheduler,
  setKept,
  summarizeUsage,
  updateTask,
} from "@/lib/runtime";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Full detail for one task: task record, ledger (runs+steps) and artifacts. */
export async function GET(_req: Request, { params }: Ctx) {
  const id = (await params).id;
  const task = getTask(id);
  if (!task) return new Response("not found", { status: 404 });
  const ledger = getLedger(id);
  return Response.json({
    task: { ...task, progress: progressOf(task), usageSummary: summarizeUsage(task.usage) },
    ledger,
    artifacts: listArtifacts(id),
  });
}

/**
 * Actions on a task. Kept as explicit verbs rather than a generic PATCH so the intent is
 * obvious and the state machine stays in one place.
 */
export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const task = getTask(id);
  if (!task) return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: "resume" | "pause" | "cancel" | "retry" | "keep-artifact" | "set-budget";
    artifactId?: string;
    kept?: boolean;
    budget?: Record<string, number>;
  };

  switch (body.action) {
    case "cancel": {
      // Stop the live run through the scheduler first so it cannot overwrite the cancelled
      // state when it unwinds, then mark cancelled.
      await scheduler().stopTask(id);
      await cancelTask(id);
      return Response.json({ task: getTask(id) });
    }
    case "pause": {
      // Pause holds the task for the user, so it must NOT auto-resume: block on input rather
      // than waiting (a waiting task with no resumeAt is treated as due and would restart).
      await scheduler().stopTask(id);
      await updateTask(id, (t) => {
        t.status = "blocked";
        t.wait = { kind: "input", message: "Paused by the user. Press Resume to continue." };
      });
      return Response.json({ task: getTask(id) });
    }
    case "resume":
    case "retry": {
      await updateTask(id, (t) => {
        t.status = "queued";
        t.wait = undefined;
        t.finishedAt = undefined;
        t.result = undefined;
      });
      scheduler().kick();
      return Response.json({ task: getTask(id) });
    }
    case "set-budget": {
      if (body.budget) await updateTask(id, (t) => Object.assign(t.budget, body.budget));
      return Response.json({ task: getTask(id) });
    }
    case "keep-artifact": {
      if (!body.artifactId) return Response.json({ error: "artifactId required" }, { status: 400 });
      const a = await setKept(body.artifactId, body.kept ?? true);
      return Response.json({ artifact: a });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = (await params).id;
  const ok = await deleteTask(id, true);
  return Response.json({ ok });
}