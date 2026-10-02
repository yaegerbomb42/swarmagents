import { scoped } from "@/lib/auth";
import { bootstrapRuntime, createTask, listTasks, loadRuntimeSettings, progressOf, scheduler, summarizeUsage } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// Bring the runtime up on first touch: this registers the agent adapter and starts the
// background scheduler, so the loop is guaranteed to run even after a cold restart.
bootstrapRuntime();

/** Task board: every task with its rolled-up progress and usage. */
export const GET = scoped(async () => {
  const tasks = listTasks().map((t) => ({
    ...t,
    progress: progressOf(t),
    usageSummary: summarizeUsage(t.usage),
  }));
  return Response.json({ tasks, settings: loadRuntimeSettings() });
});

export const POST = scoped(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    title?: string;
    inputs?: string[];
    sessionId?: string;
    budget?: Record<string, number>;
    priority?: number;
    tags?: string[];
  };
  if (!body.prompt?.trim()) return Response.json({ error: "prompt is required" }, { status: 400 });
  const task = await createTask({
    prompt: body.prompt,
    title: body.title,
    inputs: body.inputs,
    sessionId: body.sessionId,
    budget: body.budget,
    priority: body.priority,
    tags: body.tags,
  });
  scheduler().kick();
  return Response.json({ task });
});