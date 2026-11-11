import { NextRequest, NextResponse } from 'next/server';
import {
  runAgentBenchmark,
  BENCHMARK_CHALLENGES,
} from '@/lib/lab/agentEvolution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    challenges: BENCHMARK_CHALLENGES.map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      difficulty: c.difficulty,
      prompt: c.prompt,
      expectedDeliverable: c.expectedDeliverable,
      criteriaCount: c.evaluationCriteria.length,
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agentId, challengeId } = body;

    if (!agentId || !challengeId) {
      return NextResponse.json(
        { ok: false, error: 'missing_fields', detail: 'agentId and challengeId are required' },
        { status: 400 }
      );
    }

    const benchmarkResult = await runAgentBenchmark(agentId, challengeId);
    return NextResponse.json({ ok: true, benchmark: benchmarkResult });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'benchmark_execution_failed' },
      { status: 500 }
    );
  }
}
