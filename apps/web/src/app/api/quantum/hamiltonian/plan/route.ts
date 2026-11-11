import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PlanBody = {
  start: string;
  goal: string;
  transitions: Record<string, string[]>;
  action_costs?: Record<string, number>;
};

export async function POST(req: NextRequest) {
  let body: PlanBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.start || !body.goal || !body.transitions) {
    return NextResponse.json(
      { ok: false, error: 'start, goal, and transitions are required' },
      { status: 400 }
    );
  }

  const engineRes = await engineFetch<{ ok: boolean; plan: { actions: string[]; total_energy: number; steps: unknown[] } }>(
    '/api/quantum/hamiltonian/plan',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    }
  );

  if (engineRes.ok === false) {
    const costs = body.action_costs ?? {};
    const nodes = new Set(Object.keys(body.transitions));
    for (const targets of Object.values(body.transitions)) {
      for (const t of targets) nodes.add(t);
    }
    const path = aStar(body.start, body.goal, body.transitions, costs);
    return NextResponse.json({
      ok: true,
      plan: path,
      source: 'local_fallback',
    } as const);
  }

  return NextResponse.json(engineRes.data);
}

function aStar(
  start: string,
  goal: string,
  transitions: Record<string, string[]>,
  costs: Record<string, number>,
): { actions: string[]; total_energy: number; steps: unknown[] } {
  const open = new Set([start]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[start, 0]]);
  const fScore = new Map<string, number>([[start, heuristic(start, goal)]]);

  while (open.size > 0) {
    let current = '';
    let best = Infinity;
    for (const node of open) {
      const f = fScore.get(node) ?? Infinity;
      if (f < best) { best = f; current = node; }
    }
    if (current === goal) {
      const actions: string[] = [];
      let c: string | undefined = goal;
      while (c && c !== start) {
        actions.unshift(c);
        c = cameFrom.get(c);
      }
      actions.unshift(start);
      return { actions, total_energy: gScore.get(goal) ?? 0, steps: actions.map((a) => ({ node: a })) };
    }
    open.delete(current);
    const neighbors = transitions[current] ?? [];
    for (const neighbor of neighbors) {
      const edgeCost = costs[`${current}->${neighbor}`] ?? costs[neighbor] ?? 1;
      const tentative = (gScore.get(current) ?? 0) + edgeCost;
      if (tentative < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentative);
        fScore.set(neighbor, tentative + heuristic(neighbor, goal));
        open.add(neighbor);
      }
    }
  }

  return { actions: [], total_energy: 0, steps: [] };
}

function heuristic(a: string, b: string): number {
  return a === b ? 0 : 1;
}