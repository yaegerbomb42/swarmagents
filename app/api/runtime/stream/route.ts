import { currentUser, runAs } from "@/lib/store";
import { scoped } from "@/lib/auth";
import { bootstrapRuntime, listTasks, progressOf, subscribeRuntime, summarizeUsage, type RuntimeEvent } from "@/lib/runtime";
import { makeAccountFilter } from "@/lib/runtime/stream-filter";

export const dynamic = "force-dynamic";

// Live task-board stream. Mirrors the agent session stream so the UI can bind to it the
// same way. We always send a snapshot first, then incremental task updates.
//
// Server mode is multi-account, so this route is wrapped in scoped(): the snapshot is built
// under the signed-in account's runtime dir. A subscription callback fires later, outside that
// async context, so events are filtered through an account filter — one account can never
// observe another's task board.
bootstrapRuntime();

export const GET = scoped(async (req: Request) => {
  const uid = currentUser();
  // Event callbacks and timers run outside the request's runAs context, so every store read here
  // is wrapped to resolve in this account's runtime dir.
  const under = <T>(fn: () => T): T => runAs(uid, fn);
  const filter = makeAccountFilter(uid, () => under(() => new Set(listTasks().map((t) => t.id))));

  const enc = new TextEncoder();
  let sub: ((e: RuntimeEvent) => void) | null = null;
  let unsub: (() => void) | null = null;
  let ping: NodeJS.Timeout | null = null;
  let sweep: NodeJS.Timeout | null = null;

  const snapshot = () =>
    under(() => listTasks().map((t) => ({ ...t, progress: progressOf(t), usageSummary: summarizeUsage(t.usage) })));

  const stream = new ReadableStream({
    start(ctrl) {
      const send = (data: unknown) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      send({ op: "snapshot", tasks: snapshot(), uid });
      sub = (e) => {
        if (filter.admit(e as never)) send({ op: "task", event: e });
      };
      unsub = subscribeRuntime(sub);
      // Safety net: refresh ownership and push a fresh snapshot when the account's task set changed.
      sweep = setInterval(() => {
        const before = filter.ids();
        const size = before.size;
        filter.reset();
        const next = filter.ids();
        if (next.size !== size || [...next].some((id) => !before.has(id))) send({ op: "snapshot", tasks: snapshot(), uid });
      }, 10_000);
      ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 20_000);
      const cleanup = () => {
        try {
          if (unsub) unsub();
        } catch {}
        sub = null;
        unsub = null;
        if (ping) clearInterval(ping);
        if (sweep) clearInterval(sweep);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      if (ping) clearInterval(ping);
      if (sweep) clearInterval(sweep);
      if (sub) {
        try {
          if (unsub) unsub();
        } catch {}
        sub = null;
        unsub = null;
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
});