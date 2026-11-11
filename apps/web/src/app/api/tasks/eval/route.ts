/**
 * Same-model capability lift eval — SwarmAgents vs plain chat.
 * GET  → latest report
 * POST → run suite with configured provider
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  loadLatestCapabilityEval,
  runCapabilityEval,
  CAPABILITY_EVAL_FIXTURES,
} from '@/lib/capabilityEval';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  const latest = await loadLatestCapabilityEval();
  return NextResponse.json({
    ok: true,
    fixtures: CAPABILITY_EVAL_FIXTURES.map((f) => ({
      id: f.id,
      title: f.title,
      qualityBar: f.qualityBar,
    })),
    report: latest,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const providerId =
      typeof body.providerId === 'string' ? body.providerId : undefined;
    const taskIds = Array.isArray(body.taskIds)
      ? body.taskIds.filter((x: unknown) => typeof x === 'string')
      : undefined;
    const agents =
      typeof body.agents === 'number' && Number.isFinite(body.agents)
        ? Math.max(1, Math.min(3, Math.round(body.agents)))
        : undefined;

    const report = await runCapabilityEval({ providerId, taskIds, agents });
    return NextResponse.json({ ok: true, report });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
