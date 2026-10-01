import { createTask, listTasks, loadRuntimeSettings, progressOf, scheduler, summarizeUsage } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// Ensure the scheduler is running whenever the runtime API is touched. This is the
// single place the background loop is guaranteed to come up, even after a cold restart.
scheduler().start();

/** Task board: every task with its rolled-up progress and usage. */
export async function GET() {
  const tasks = listTasks().map((t) => ({
    ...t,
    progress: progressOf(t),
    usageSummary: summarizeUsage(t.usage),
  }));
  return Response.json({ tasks, settings: loadRuntimeSettings() });
}

export async function POST(req: Request) {
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
}