import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = ["thought", "tool_call", "tool_result", "memory", "state", "error"] as const;
const THOUGHTS = [
  "planning next step",
  "evaluating tool output",
  "summarizing context",
  "decomposing subtask",
  "checking invariants",
  "searching memory",
  "ranking candidates",
  "validating assumptions",
];
const TOOLS = ["read_file", "grep", "shell", "web_search", "apply_patch", "recall_memory"];

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeEvent(agentIdx: number, t: number) {
  const r = Math.random();
  const type = r < 0.40 ? "thought" : r < 0.60 ? "tool_call" : r < 0.78 ? "tool_result" : r < 0.88 ? "memory" : r < 0.97 ? "state" : "error";
  const payload: Record<string, unknown> = {};
  if (type === "thought") payload.text = THOUGHTS[Math.floor(Math.random() * THOUGHTS.length)];
  else if (type === "tool_call") payload.tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
  else if (type === "tool_result") payload.ok = Math.random() > 0.05;
  else if (type === "memory") payload.op = Math.random() > 0.5 ? "write" : "read";
  else if (type === "state") payload.phase = Math.random() > 0.5 ? "act" : "plan";
  else payload.message = "transient tool failure";
  return {
    id: rid("evt"),
    agentId: `agent-${String(agentIdx).padStart(4, "0")}`,
    type,
    payload,
    timestamp: t,
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agents = Math.min(Math.max(parseInt(url.searchParams.get("agents") ?? "500", 10) || 500, 1), 1000);
  const rate = Math.min(Math.max(parseFloat(url.searchParams.get("rate") ?? "5") || 5, 0.1), 50);
  const tickMs = 200;

  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const eventsPerTickPerAgent = (rate * tickMs) / 1000;
      interval = setInterval(() => {
        if (closed) return;
        try {
          const now = Date.now();
          const lines: string[] = [];
          for (let a = 0; a < agents; a++) {
            // Poisson-ish: emit floor(p) + (rand < frac ? 1 : 0) events
            const p = eventsPerTickPerAgent;
            let n = Math.floor(p);
            if (Math.random() < p - n) n += 1;
            for (let k = 0; k < n; k++) {
              lines.push(`data: ${JSON.stringify(makeEvent(a, now))}\n\n`);
            }
          }
          if (lines.length) controller.enqueue(encoder.encode(lines.join("")));
        } catch {
          if (interval) clearInterval(interval);
        }
      }, tickMs);

      // Heartbeat as SSE comment every 15s to keep proxies alive
      const hb = setInterval(() => {
        if (closed) {
          clearInterval(hb);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
        } catch {
          clearInterval(hb);
        }
      }, 15000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
