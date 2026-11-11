import { NextRequest, NextResponse } from 'next/server';
import { ENGINE_BASE, engineFetch } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await engineFetch('/api/semantic/state');
  if (result.ok === false) {
    return NextResponse.json(
      { success: false, error: result.error, note: 'Semantic state unavailable' },
      { status: result.status || 503 },
    );
  }
  return NextResponse.json(result.data);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body.action || 'probe');
  const pathMap: Record<string, string> = {
    probe: '/api/semantic/probe',
    pollinate: '/api/semantic/pollinate',
    update: '/api/semantic/state',
    reset: '/api/semantic/state/reset',
    'state-graph': '/api/state-graph/run',
  };
  const path = pathMap[action];
  if (!path) {
    return NextResponse.json({ error: 'unknown_action', known: Object.keys(pathMap) }, { status: 400 });
  }

  const result = await engineFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 90_000,
  });

  if (result.ok === false) {
    return NextResponse.json(
      { success: false, error: result.error, engine: ENGINE_BASE },
      { status: result.status || 503 },
    );
  }
  return NextResponse.json(result.data);
}
