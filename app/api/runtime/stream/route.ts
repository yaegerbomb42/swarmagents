import { bootstrapRuntime, listTasks, progressOf, subscribeRuntime, summarizeUsage, type RuntimeEvent } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// Live task-board stream. Mirrors the agent session stream so the UI can bind to it the
// same way. We always send a snapshot first, then incremental task updates.
bootstrapRuntime();

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let sub: ((e: RuntimeEvent) => void) | null = null;
  let ping: NodeJS.Timeout | null = null;

  const snapshot = () =>
    listTasks().map((t) => ({ ...t, progress: progressOf(t), usageSummary: summarizeUsage(t.usage) }));

  const stream = new ReadableStream({
    start(ctrl) {
      const send = (data: unknown) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      send({ op: "snapshot", tasks: snapshot() });
      sub = (e) => send({ op: "task", event: e });
      subscribeRuntime(sub);
      ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 20_000);
      req.signal.addEventListener("abort", () => {
        if (sub) sub = null;
        if (ping) clearInterval(ping);
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      if (ping) clearInterval(ping);
      sub = null;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}