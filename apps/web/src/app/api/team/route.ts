/**
 * Team Mode — dispatch + list.
 *
 * POST /api/team  { prompt, settings?, userId? } → { ok, run }
 * GET  /api/team  → recent runs (no prompt text, just status/plan shape).
 *
 * The run executes in the background on this VM; the panel follows it over
 * GET /api/team/<runId> (SSE).
 */

import { NextRequest, NextResponse } from 'next/server';
import { startTeamRun } from '@/lib/team/runner';
import { listTeamRuns } from '@/lib/team/registry';
import { resolveTeamSettings, type TeamSettings } from '@/lib/team/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PROMPT = 8_000;

function authorized(req: NextRequest): boolean {
  const required = process.env.HARNESS_ACCESS_TOKEN;
  if (!required) return true;
  return (req.headers.get('authorization') || '') === `Bearer ${required}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
  }
  let body: { prompt?: string; settings?: Partial<TeamSettings>; userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json({ ok: false, error: `prompt is over ${MAX_PROMPT} characters` }, { status: 413 });
  }

  try {
    const run = await startTeamRun({
      prompt,
      userId: body.userId ? String(body.userId).slice(0, 80) : 'local',
      settings: resolveTeamSettings(body.settings),
    });
    return NextResponse.json({ ok: true, runId: run.runId, run });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'team dispatch failed' },
      { status: 500 },
    );
  }
}

export async function GET() {
  const runs = listTeamRuns().slice(0, 20).map((r) => ({
    runId: r.runId,
    goal: r.goal,
    status: r.status,
    createdAt: r.createdAt,
    plan: r.plan,
    agents: r.agents,
    budget: r.budget,
  }));
  return NextResponse.json({ ok: true, runs });
}