/// <reference types="node" />

import { NextRequest, NextResponse } from 'next/server';
import { createAgent, listAgents, updateAgent, joinCollective, calculateFitness } from '@/lib/swarm-market/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const agent = createAgent({
      name: body.name,
      owner_id: body.owner_id || 'anonymous',
      owner_name: body.owner_name || 'Anonymous',
      lora_dna: body.lora_dna,
      personality: body.personality,
      gpu_endpoint: body.gpu_endpoint,
      gpu_model: body.gpu_model,
    });
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const agents = listAgents().map((a) => ({
      ...a,
      fitness: calculateFitness(a),
    }));
    return NextResponse.json({ ok: true, agents });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === 'join_collective' && body.agent_id) {
      const ok = joinCollective(body.agent_id);
      return NextResponse.json({ ok });
    }
    if (body.id) {
      const agent = updateAgent(body.id, body);
      return NextResponse.json({ ok: !!agent, agent });
    }
    return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
