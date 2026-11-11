import { NextRequest, NextResponse } from 'next/server';
import { MARKETPLACE_SEED_AGENTS } from '@/lib/lab/marketplaceCatalog';
import { validateBlueprint, AgentBlueprint } from '@/lib/lab/agentBlueprint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-memory runtime persistence for newly published agents
let customMarketplaceAgents: AgentBlueprint[] = [];

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category');
    const search = searchParams.get('search')?.toLowerCase();
    const id = searchParams.get('id');

    const allAgents = [...MARKETPLACE_SEED_AGENTS, ...customMarketplaceAgents];

    if (id) {
      const found = allAgents.find((a) => a.id === id);
      if (!found) {
        return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, agent: found });
    }

    let filtered = allAgents;

    if (category && category !== 'all') {
      filtered = filtered.filter((a) => a.category === category);
    }

    if (search) {
      filtered = filtered.filter(
        (a) =>
          a.name.toLowerCase().includes(search) ||
          a.role.toLowerCase().includes(search) ||
          a.description.toLowerCase().includes(search) ||
          a.domainTags.some((t) => t.toLowerCase().includes(search))
      );
    }

    return NextResponse.json({
      ok: true,
      count: filtered.length,
      agents: filtered,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'failed_to_fetch_marketplace' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const validation = validateBlueprint(body);

    if (!validation.valid || !validation.blueprint) {
      return NextResponse.json(
        { ok: false, error: 'invalid_manifest', details: validation.errors },
        { status: 400 }
      );
    }

    const blueprint = validation.blueprint;
    blueprint.isPublic = true;
    blueprint.updatedAt = new Date().toISOString();

    // Replace if already exists, else prepend
    const existingIndex = customMarketplaceAgents.findIndex((a) => a.id === blueprint.id);
    if (existingIndex >= 0) {
      customMarketplaceAgents[existingIndex] = blueprint;
    } else {
      customMarketplaceAgents.unshift(blueprint);
    }

    return NextResponse.json({
      ok: true,
      agent: blueprint,
      message: 'Agent published to global marketplace',
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'failed_to_publish_agent' },
      { status: 500 }
    );
  }
}
