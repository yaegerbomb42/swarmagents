import { eventBus } from '@/lib/eventBus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-side route: prefer the server env, then the public one, then local dev.
const ENGINE_URL =
  process.env.ENGINE_URL || process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:8400';

const HEARTBEAT_MS = 15000;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function systemEvent(action: string, message?: string) {
  return {
    type: 'system',
    action,
    payload: message ? { message } : {},
    id: `${action}-${Date.now()}`,
    timestamp: Date.now(),
  };
}

/**
 * Bridge engine WS events into the SSE stream. Falls back to the local
 * eventBus when the engine WS errors or closes. Returns a cleanup that
 * closes the upstream socket and all timers/subscriptions.
 */
function bridgeEngineEvents(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let unsubLocal: (() => void) | null = null;

  const send = (obj: unknown) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(sse(obj)));
    } catch {
      cleanup();
    }
  };

  const heartbeat = setInterval(() => send(systemEvent('heartbeat')), HEARTBEAT_MS);

  const fallbackToLocal = (message: string) => {
    if (closed || unsubLocal) return;
    send(systemEvent('warning', message));
    unsubLocal = eventBus.subscribe((evt) => send(evt));
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubLocal?.();
    unsubLocal = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
  }

  try {
    const wsUrl = ENGINE_URL.replace(/^http/, 'ws') + '/ws/events';
    ws = new WebSocket(wsUrl);

    ws.onopen = () => send(systemEvent('connected', 'Engine WebSocket bridge active'));

    ws.onmessage = (msg) => {
      try {
        const evt = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        // Engine WS frame: { id, type, source, payload, timestamp }.
        // For agent inner-world events, payload is the agent envelope
        // { id, agentId, type, payload, timestamp } — unwrap it so the
        // inner-world grid can demux by agentId directly.
        const inner = evt.payload && typeof evt.payload === 'object' ? evt.payload : null;
        const isAgentEnvelope =
          inner && typeof inner.agentId === 'string' && typeof inner.type === 'string';
        const ts =
          typeof evt.timestamp === 'number'
            ? evt.timestamp > 1e12
              ? evt.timestamp
              : evt.timestamp * 1000
            : Date.now();
        const dashboardEvent = isAgentEnvelope
          ? {
              id: inner.id || evt.id || `evt-${Date.now()}`,
              agentId: inner.agentId,
              type: inner.type,
              action: 'agent',
              payload: { ...(inner.payload || {}), session_id: inner.session_id ?? inner.payload?.session_id },
              timestamp: typeof inner.timestamp === 'number' ? inner.timestamp : ts,
            }
          : {
              id: evt.id || `evt-${Date.now()}`,
              type: evt.type || 'system',
              action: evt.source || 'engine',
              payload: evt.payload || evt,
              timestamp: ts,
            };
        // Also push to local eventBus for non-SSE consumers
        eventBus.emit(dashboardEvent);
        send(dashboardEvent);
      } catch {
        // Skip malformed messages
      }
    };

    ws.onerror = () => {
      fallbackToLocal('Engine WebSocket unavailable, falling back to local events');
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      ws = null;
      fallbackToLocal('Engine WebSocket closed, serving local events only');
    };
  } catch {
    fallbackToLocal('Engine unreachable, serving local events only');
  }

  return cleanup;
}

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  // Serve initial local history
  const history = eventBus.getHistory();
  const initData = history.slice(-20).map((evt) => sse(evt)).join('');

  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      if (initData) controller.enqueue(encoder.encode(initData));
      cleanup = bridgeEngineEvents(controller, encoder);
      const onAbort = () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
