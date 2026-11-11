import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

/**
 * GET /api/autonomous/status
 * Returns current status of the background self-improvement loop.
 */
export async function GET() {
  try {
    const res = await fetch(`${ENGINE_URL}/api/decomposition/autonomous/status`, {
      cache: 'no-store',
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ running: false, error: 'Engine status failed' }, { status: res.status });
  } catch (error) {
    return NextResponse.json({ running: false, error: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/autonomous/start or stop
 * Body: { action: 'start' | 'stop' }
 */
export async function POST(request: NextRequest) {
  try {
    const { action } = await request.json();
    const targetUrl = action === 'start' 
      ? `${ENGINE_URL}/api/decomposition/autonomous/start`
      : `${ENGINE_URL}/api/decomposition/autonomous/stop`;

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ error: `Failed to ${action} loop` }, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
