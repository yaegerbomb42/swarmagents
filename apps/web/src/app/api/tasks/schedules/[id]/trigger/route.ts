import { NextRequest, NextResponse } from 'next/server';
import { engineForwardHeaders, requireAuth } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  const { id } = await ctx.params;
  const headers = engineForwardHeaders(request);

  try {
    const res = await fetch(`${ENGINE_URL}/api/decomposition/schedules/${id}/trigger`, {
      method: 'POST',
      headers,
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ error: 'Failed to trigger schedule execution' }, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
