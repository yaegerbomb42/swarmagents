/// <reference types="node" />

import { NextRequest, NextResponse } from 'next/server';
import { getAutopilotStatus, toggleAutopilot } from '@/lib/swarm-market/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: getAutopilotStatus() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === 'toggle') {
      const status = toggleAutopilot();
      return NextResponse.json({ ok: true, status });
    }
    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
