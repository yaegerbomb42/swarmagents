import { NextRequest, NextResponse } from 'next/server';
import {
  matrixToEngineConfig,
  type RoleRoute,
  type AgentRole,
} from '@/lib/routingMatrix';
import {
  loadRoutingMatrix,
  saveRoutingMatrix,
  refreshRpmWindows,
  tickRoleUsage,
  resetRoleUsage,
} from '@/lib/routingStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

/** GET — current matrix + live usage + recent failover events + router metrics */
export async function GET() {
  const matrix = refreshRpmWindows(await loadRoutingMatrix());
  let failoverEvents: unknown[] = [];
  let routerMetrics: Record<string, unknown> | null = null;
  let providerMetrics: Record<string, unknown> | null = null;
  try {
    const [failRes, metricsRes, providerRes] = await Promise.all([
      fetch(`${ENGINE_URL}/llm/failover/events?limit=15`, {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      }),
      fetch(`${ENGINE_URL}/api/quantum/router/metrics`, {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      }),
      fetch(`${ENGINE_URL}/api/quantum/router/metrics/providers`, {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      }),
    ]);
    if (failRes.ok) {
      const body = await failRes.json();
      failoverEvents = body.events || [];
    }
    if (metricsRes.ok) {
      routerMetrics = await metricsRes.json();
    }
    if (providerRes.ok) {
      providerMetrics = await providerRes.json();
    }
  } catch {
    /* engine offline */
  }
  return NextResponse.json({
    ok: true,
    matrix,
    engineUrl: ENGINE_URL,
    failoverEvents,
    routerMetrics,
    providerMetrics,
  });
}

/** PUT — replace routes (and optionally push to engine) */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await loadRoutingMatrix();

    let routes: RoleRoute[] = current.routes;
    if (Array.isArray(body.routes)) {
      routes = body.routes.map((r: RoleRoute) => ({
        ...r,
        fallbacks: Array.isArray(r.fallbacks) ? r.fallbacks.map(String) : [],
        rpmLimit: Math.max(1, Number(r.rpmLimit) || 30),
        dailyBudgetUsd: Math.max(0, Number(r.dailyBudgetUsd) || 0),
        maxConcurrent: Math.max(1, Number(r.maxConcurrent) || 1),
        enabled: r.enabled !== false,
      }));
    } else if (body.route?.role) {
      routes = current.routes.map((r) =>
        r.role === body.route.role ? { ...r, ...body.route } : r
      );
    }

    const matrix = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      routes,
      usage: current.usage,
    };

    await saveRoutingMatrix(matrix);

    let engineSynced = false;
    let engineError: string | undefined;
    if (body.syncEngine !== false) {
      try {
        const payload = matrixToEngineConfig(matrix);
        const res = await fetch(`${ENGINE_URL}/api/decomposition/config/providers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(4000),
        });
        engineSynced = res.ok;
        if (!res.ok) engineError = `engine ${res.status}`;
      } catch (e) {
        engineError = String(e);
      }
    }

    return NextResponse.json({
      ok: true,
      matrix: refreshRpmWindows(matrix),
      engineSynced,
      engineError,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/**
 * POST — record usage tick OR reset usage
 * { action: 'tick', role, tokens?, costUsd? } | { action: 'reset' }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === 'reset') {
      const matrix = await resetRoleUsage();
      return NextResponse.json({ ok: true, matrix });
    }

    if (body.action === 'tick') {
      const role = body.role as AgentRole;
      if (!role) {
        return NextResponse.json({ ok: false, error: 'role required' }, { status: 400 });
      }
      const result = await tickRoleUsage(role, {
        tokens: Number(body.tokens) || 0,
        costUsd: Number(body.costUsd) || 0,
      });
      const matrix = refreshRpmWindows(await loadRoutingMatrix());
      return NextResponse.json({
        ok: true,
        usage: result.usage,
        throttled: result.throttled,
        reason: result.reason,
        matrix,
      });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
