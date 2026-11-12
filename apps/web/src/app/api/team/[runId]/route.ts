/**
 * Team Mode — one run.
 *
 * GET /api/team/<runId>                → SSE: {op:'snapshot'} then {op:'run', run, event}
 * GET /api/team/<runId>?format=json    → snapshot + event log
 *
 * Replays the current run first, so a late subscriber sees the whole story.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTeamRun, getTeamRunEvents, subscribeTeamRun } from '@/lib/team/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getTeamRun(runId);
  if (!run) return NextResponse.json({ ok: false, error: 'team run not found' }, { status: 404 });

  const wantsJson =
    (req.headers.get('accept') || '').includes('application/json') ||
    new URL(req.url).searchParams.get('format') === 'json';
  if (wantsJson) {
    return NextResponse.json({ ok: true, run, events: getTeamRunEvents(runId) });
  }

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (obj: unknown) => write(`data: ${JSON.stringify(obj)}\n\n`);

      send({ op: 'snapshot', run });
      unsub = subscribeTeamRun(runId, (next) => send({ op: 'run', run: next }));
      heartbeat = setInterval(() => write(': hb\n\n'), HEARTBEAT_MS);

      const stop = () => {
        if (closed) return;
        closed = true;
        unsub?.();
        unsub = null;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', stop, { once: true });
    },
    cancel() {
      unsub?.();
      unsub = null;
      if (heartbeat) clearInterval(heartbeat);
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