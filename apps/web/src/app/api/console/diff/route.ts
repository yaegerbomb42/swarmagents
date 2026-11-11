import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PatchStatus = 'pending' | 'approved' | 'rejected';

interface PatchRecord {
  sessionId: string;
  filename: string;
  patch: string;
  status: PatchStatus;
  updatedAt: number;
}

const patchStore = new Map<string, PatchRecord>();

function patchKey(sessionId: string, filename: string): string {
  return `${sessionId}::${filename}`;
}

/**
 * SSE stream of unified diff hunks. There is no live engine diff source wired
 * yet, so this only replays a patch that was actually recorded for the
 * session/file (via POST). Otherwise it emits `meta` + `done` with
 * `empty: true` — never demo content.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? 'default';
  const filename = req.nextUrl.searchParams.get('filename') ?? '';
  const record = filename ? patchStore.get(patchKey(sessionId, filename)) : undefined;
  const chunks = record?.patch ? record.patch.split(/(?<=\n)/) : [];

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const stream = new ReadableStream({
    start(controller) {
      send(controller, { type: 'meta', sessionId, filename, timestamp: Date.now() });
      chunks.forEach((text, index) => send(controller, { type: 'chunk', text, index }));
      send(controller, {
        type: 'done',
        filename,
        empty: chunks.length === 0,
        ...(chunks.length === 0 ? { reason: 'no diff recorded for this file' } : {}),
        timestamp: Date.now(),
      });
      controller.close();
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

/** Approve or reject a streamed patch. */
export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    sessionId?: string;
    filename?: string;
    patch?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const action = body.action?.toLowerCase();
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });
  }

  const sessionId = body.sessionId ?? 'default';
  const filename = body.filename ?? 'unknown';
  const patch = body.patch ?? '';

  const key = patchKey(sessionId, filename);
  const status: PatchStatus = action === 'approve' ? 'approved' : 'rejected';
  patchStore.set(key, { sessionId, filename, patch, status, updatedAt: Date.now() });

  return NextResponse.json({ ok: true, status, sessionId, filename });
}

/** Test helper — internal store query helper. */
function _getPatchStatus(sessionId: string, filename: string): PatchStatus | null {
  return patchStore.get(patchKey(sessionId, filename))?.status ?? null;
}
