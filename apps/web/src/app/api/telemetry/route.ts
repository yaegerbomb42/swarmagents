export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { telemetryBridge } from '@/lib/telemetryBridge';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') || 'default';

  // SSE streaming mode
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));

      const sink = {
        write: (data: string) => {
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            sink.closed = true;
          }
        },
        closed: false,
      };

      const unsubscribe = telemetryBridge.subscribe(projectId, sink);

      const heartbeat = setInterval(() => {
        if (sink.closed) {
          clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(
              `event: heartbeat\ndata: ${JSON.stringify({ type: 'system', action: 'heartbeat', timestamp: Date.now() })}\n\n`
            )
          );
        } catch {
          sink.closed = true;
          clearInterval(heartbeat);
        }
      }, 15_000);

      request.signal.addEventListener('abort', () => {
        sink.closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
