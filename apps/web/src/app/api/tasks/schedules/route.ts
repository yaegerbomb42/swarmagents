import { NextRequest, NextResponse } from 'next/server';
import { engineForwardHeaders, requireAuth } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  const headers = engineForwardHeaders(request);

  try {
    const res = await fetch(`${ENGINE_URL}/api/decomposition/schedules`, {
      cache: 'no-store',
      headers,
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ error: 'Failed to fetch schedules' }, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  const headers = engineForwardHeaders(request);
  try {
    const body = await request.json();
    const res = await fetch(`${ENGINE_URL}/api/decomposition/schedules`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
