import { NextRequest, NextResponse } from 'next/server';
import { breedAgents, listTunedAgents } from '@/lib/lab/agentEvolution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { parentAId, parentBId, childName, autoBreedTop } = body;

    if (autoBreedTop) {
      const agents = listTunedAgents();
      const eligible = agents.filter((a) => a.tasksCompleted > 0 || a.avgScore > 0);
      if (eligible.length < 2) {
        return NextResponse.json(
          { ok: false, error: 'insufficient_agents', detail: 'Need at least 2 evaluated agents to auto-breed' },
          { status: 400 }
        );
      }
      const sorted = [...eligible].sort((a, b) => b.fitness - a.fitness);
      const child = breedAgents(sorted[0].id, sorted[1].id);
      return NextResponse.json({ ok: true, child, parents: [sorted[0].id, sorted[1].id] });
    }

    if (!parentAId || !parentBId) {
      return NextResponse.json(
        { ok: false, error: 'missing_parents', detail: 'parentAId and parentBId are required' },
        { status: 400 }
      );
    }

    const child = breedAgents(parentAId, parentBId, childName);
    return NextResponse.json({ ok: true, child });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'evolution_failed' },
      { status: 500 }
    );
  }
}
