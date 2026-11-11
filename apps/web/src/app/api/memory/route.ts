import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Proxy GET /api/memory → engine /api/memory/active-goal */
export async function GET() {
  const res = await engineFetch('/api/memory/active-goal');
  if (res.ok === false) {
    return NextResponse.json({ error: res.error }, { status: res.status || 502 });
  }
  return NextResponse.json(res.data);
}

/** Proxy POST /api/memory → engine lesson create */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const res = await engineFetch('/api/memory/lessons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.ok === false) {
    return NextResponse.json({ error: res.error }, { status: res.status || 502 });
  }
  return NextResponse.json(res.data);
}
