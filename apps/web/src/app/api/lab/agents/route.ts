import { NextRequest, NextResponse } from 'next/server';
import {
  createTunedAgent,
  listTunedAgents,
  lockAgentDna,
  getTunedAgent,
} from '@/lib/lab/agentEvolution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const ownerId = searchParams.get('ownerId') || undefined;

    if (id) {
      const agent = getTunedAgent(id);
      if (!agent) {
        return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, agent });
    }

    const agents = listTunedAgents(ownerId);
    return NextResponse.json({ ok: true, agents });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'failed_to_list_agents' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, role, llmConfig, contextDna, ownerId, ownerName, locked } = body;

    if (!name || !role || !llmConfig || !contextDna) {
      return NextResponse.json(
        { ok: false, error: 'missing_fields', detail: 'name, role, llmConfig, and contextDna are required' },
        { status: 400 }
      );
    }

    const agent = createTunedAgent({
      name,
      role,
      llmConfig,
      contextDna,
      ownerId,
      ownerName,
      locked,
    });

    return NextResponse.json({ ok: true, agent });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'failed_to_create_agent' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { agentId, action } = body;

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'missing_agent_id' }, { status: 400 });
    }

    if (action === 'lock') {
      const locked = lockAgentDna(agentId);
      if (!locked) {
        return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, agent: locked });
    }

    return NextResponse.json({ ok: false, error: 'invalid_action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'failed_to_update_agent' }, { status: 500 });
  }
}
