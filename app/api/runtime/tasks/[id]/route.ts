import { scoped } from "@/lib/auth";
import {
  addStep,
  cancelTask,
  clearApprovals,
  clearDenials,
  deleteTask,
  getLedger,
  getTask,
  grantApproval,
  listArtifacts,
  progressOf,
  recordDenial,
  scheduler,
  setKept,
  summarizeUsage,
  updateTask,
} from "@/lib/runtime";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Full detail for one task: task record, ledger (runs+steps) and artifacts. */
export const GET = scoped(async (_req: Request, { params }: Ctx) => {
  const id = (await params).id;
  const task = getTask(id);
  if (!task) return new Response("not found", { status: 404 });
  const ledger = getLedger(id);
  return Response.json({
    task: { ...task, progress: progressOf(task), usageSummary: summarizeUsage(task.usage) },
    ledger,
    artifacts: listArtifacts(id),
  });
});

/**
 * Actions on a task. Kept as explicit verbs rather than a generic PATCH so the intent is
 * obvious and the state machine stays in one place.
 */
export const POST = scoped(async (req: Request, { params }: Ctx) => {
  const id = (await params).id;
  const task = getTask(id);
  if (!task) return new Response("not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: "resume" | "pause" | "cancel" | "retry" | "approve" | "deny" | "keep-artifact" | "set-budget";
    artifactId?: string;
    kept?: boolean;
    budget?: Record<string, number>;
  };

  switch (body.action) {
    case "cancel": {
      // Stop the live run through the scheduler first so it cannot overwrite the cancelled
      // state when it unwinds, then mark cancelled. If the run ignored the abort and did not
      // settle in time, say so rather than implying its side effects have stopped.
      const settled = await scheduler().stopTask(id);
      await cancelTask(id);
      clearApprovals(id);
      clearDenials(id);
      if (!settled) {
        await addStep(id, "", { kind: "notice", label: "Cancellation requested", detail: "A running tool is still unwinding; it will be told to stop but may finish its current step." });
      }
      return Response.json({ task: getTask(id) });
    }
    case "pause": {
      // Pause holds the task for the user, so it must NOT auto-resume: block on input rather
      // than waiting (a waiting task with no resumeAt is treated as due and would restart).
      const settled = await scheduler().stopTask(id);
      await updateTask(id, (t) => {
        t.status = "blocked";
        t.wait = { kind: "input", message: "Paused by the user. Press Resume to continue." };
      });
      if (!settled) {
        await addStep(id, "", { kind: "notice", label: "Pause requested", detail: "A running tool ignored the stop signal and is finishing its current step." });
      }
      return Response.json({ task: getTask(id) });
    }
    case "approve": {
      // Authorise exactly the action the task is blocked on, then resume. The grant is bound to the
      // action hash stored on the wait, so it cannot authorise a different command later.
      const t = getTask(id);
      const token = t?.wait?.kind === "approval" ? t.wait.token : undefined;
      if (token) {
        const tool = /^(\w+)/.exec(t?.wait?.message ?? "")?.[1] ?? "action";
        await grantApproval({ taskId: id, hash: token, tool, label: t?.wait?.message ?? "", grantedAt: Date.now() });
        await addStep(id, "", { kind: "notice", label: "Approved", detail: t?.wait?.message ?? "Action approved by the user." });
      }
      await updateTask(id, (x) => {
        x.status = "queued";
        x.wait = undefined;
        x.finishedAt = undefined;
        x.result = undefined;
      });
      scheduler().kick();
      return Response.json({ task: getTask(id) });
    }
    case "deny": {
      // Refuse exactly the action the task is blocked on, then resume so the agent can work another way.
      const t = getTask(id);
      const token = t?.wait?.kind === "approval" ? t.wait.token : undefined;
      if (token) {
        await recordDenial({ taskId: id, hash: token, tool: "action", label: t?.wait?.message ?? "", deniedAt: Date.now() });
        await addStep(id, "", { kind: "notice", label: "Denied", detail: t?.wait?.message ?? "Action denied by the user." });
      }
      await updateTask(id, (x) => {
        x.status = "queued";
        x.wait = undefined;
        x.finishedAt = undefined;
        x.result = undefined;
      });
      scheduler().kick();
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
});

export const DELETE = scoped(async (_req: Request, { params }: Ctx) => {
  const id = (await params).id;
  const task = getTask(id);
  if (!task) return new Response("not found", { status: 404 });
  const ok = await deleteTask(id, true);
  clearApprovals(id);
  clearDenials(id);
  if (!ok) return new Response("not found", { status: 404 });
  return Response.json({ ok });
});