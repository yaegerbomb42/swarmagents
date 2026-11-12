/**
 * Team Mode — take over one lane.
 *
 * POST /api/team/<runId>/takeover { agentId } → { ok, run }
 * The lane stops accepting new work and waits for the user in its folder.
 */

import { NextRequest, NextResponse } from 'next/server';
import { takeOverAgent } from '@/lib/team/runner';
import { getTeamRun } from '@/lib/team/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  let body: { agentId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const agentId = String(body.agentId || '').trim();
  if (!agentId) return NextResponse.json({ ok: false, error: 'agentId is required' }, { status: 400 });
  if (!getTeamRun(runId)) return NextResponse.json({ ok: false, error: 'team run not found' }, { status: 404 });

  const run = takeOverAgent(runId, agentId);
  if (!run) return NextResponse.json({ ok: false, error: 'team run not found' }, { status: 404 });
  return NextResponse.json({ ok: true, run });
}