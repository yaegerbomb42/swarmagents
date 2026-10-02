import { scoped } from "@/lib/auth";
import { session } from "@/lib/agent";
import { browserRuntime, type BrowserEvent, type BrowserStatus } from "@/lib/browser";

export const dynamic = "force-dynamic";

// Live browser viewer stream. CDP screencast frames (base64 JPEG) and session events are pushed
// as server-sent events so the panel updates with no polling and no WebSocket server to run.
//
// Auth: wrapped in scoped(), which resolves the signed-in user and runs in their data scope; the
// requested session is looked up through lib/agent's tenant-scoped store, so a viewer can only
// stream a browser that belongs to a task they own. Middleware additionally 401s anonymous /api calls.

const enc = new TextEncoder();
/** ~12 fps to viewers: enough to look live, cheap enough to stay under SMB on a phone. */
const MIN_FRAME_GAP_MS = 80;

/** Session ids are 16 hex chars (lib/store). Validate before touching the store so a bogus id is a
 *  clean 404 rather than a thrown "bad session id". */
const SESSION_ID = /^[a-f0-9]{16}$/;

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sid = url.searchParams.get("session") ?? "";
  if (!SESSION_ID.test(sid) || !session(sid)) return Response.json({ error: "No such task." }, { status: 404 });

  const rt = browserRuntime();
  const send = (ctrl: ReadableStreamDefaultController<Uint8Array>, data: unknown) => {
    try {
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {}
  };

  let sub: (() => void) | null = null;
  let ping: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let lastFrame = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const attach = () => {
        const s = rt.get(sid);
        if (!s) return false;
        send(ctrl, { type: "hello", status: s.status() satisfies BrowserStatus });
        sub = s.onFrame((f) => {
          const now = Date.now();
          if (now - lastFrame < MIN_FRAME_GAP_MS) return;
          lastFrame = now;
          send(ctrl, { type: "frame", data: f.data, ts: f.ts, n: f.n, offsetTop: f.offsetTop });
        });
        const offEvent = s.onEvent((e: BrowserEvent) => {
          send(ctrl, { type: "event", event: e });
          if (e.type === "closed") {
            send(ctrl, { type: "closed", reason: e.reason });
            try {
              ctrl.close();
            } catch {}
          }
        });
        // A late viewer still sees the most recent keyframe immediately.
        const last = rt.replay(sid).filter((r) => r.kind === "frame").at(-1);
        if (last?.frame) send(ctrl, { type: "frame", data: last.frame, ts: last.ts, n: 0 });
        const prev = sub;
        sub = () => {
          prev?.();
          offEvent();
        };
        return true;
      };

      if (!attach()) {
        send(ctrl, { type: "hello", status: { key: sid, live: false } });
        // The agent may not have opened the browser yet; wait for it instead of failing the viewer.
        poll = setInterval(() => {
          if (attach() && poll) {
            clearInterval(poll);
            poll = null;
          }
        }, 500);
      }
      ping = setInterval(() => {
        try {
          ctrl.enqueue(enc.encode(": ping\n\n"));
        } catch {}
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        sub?.();
        if (ping) clearInterval(ping);
        if (poll) clearInterval(poll);
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      sub?.();
      if (ping) clearInterval(ping);
      if (poll) clearInterval(poll);
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

export const GET = scoped(handler);