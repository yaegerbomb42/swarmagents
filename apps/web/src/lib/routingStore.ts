import { promises as fs } from 'fs';
import path from 'path';
import {
  createDefaultMatrix,
  type RoutingMatrix,
  type RouteUsage,
  type AgentRole,
} from '@/lib/routingMatrix';

const STORE_PATH = path.join(process.cwd(), '.data', 'routing-matrix.json');

const g = globalThis as typeof globalThis & {
  __swarmRoutingMatrix?: RoutingMatrix;
  __swarmRoutingRpm?: Map<string, number[]>;
};

function rpmMap() {
  if (!g.__swarmRoutingRpm) g.__swarmRoutingRpm = new Map();
  return g.__swarmRoutingRpm;
}

export async function loadRoutingMatrix(): Promise<RoutingMatrix> {
  if (g.__swarmRoutingMatrix) return g.__swarmRoutingMatrix;
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as RoutingMatrix;
    if (parsed?.version === 1 && Array.isArray(parsed.routes)) {
      g.__swarmRoutingMatrix = parsed;
      return parsed;
    }
  } catch {
    /* missing */
  }
  const fresh = createDefaultMatrix();
  g.__swarmRoutingMatrix = fresh;
  return fresh;
}

export async function saveRoutingMatrix(matrix: RoutingMatrix): Promise<void> {
  matrix.updatedAt = new Date().toISOString();
  g.__swarmRoutingMatrix = matrix;
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(matrix, null, 2), 'utf8');
  } catch {
    /* in-memory ok */
  }
}

export function refreshRpmWindows(matrix: RoutingMatrix): RoutingMatrix {
  const now = Date.now();
  const map = rpmMap();
  const usage = matrix.usage.map((u) => {
    const stamps = (map.get(u.role) || []).filter((t) => now - t < 60_000);
    map.set(u.role, stamps);
    return { ...u, rpmWindow: stamps.length };
  });
  return { ...matrix, usage };
}

export async function tickRoleUsage(
  role: AgentRole,
  opts: { tokens?: number; costUsd?: number } = {}
): Promise<{ usage: RouteUsage; throttled: boolean; reason: 'rpm' | 'budget' | null }> {
  const matrix = await loadRoutingMatrix();
  const now = Date.now();
  const stamps = rpmMap().get(role) || [];
  stamps.push(now);
  rpmMap().set(
    role,
    stamps.filter((t) => now - t < 60_000)
  );

  let usageList = matrix.usage.map((u) => {
    if (u.role !== role) return u;
    return {
      ...u,
      callsToday: u.callsToday + 1,
      tokensToday: u.tokensToday + (opts.tokens || 0),
      spendUsd: Math.round((u.spendUsd + (opts.costUsd || 0)) * 10000) / 10000,
      rpmWindow: (rpmMap().get(role) || []).length,
      lastCallAt: now,
    };
  });
  if (!usageList.some((u) => u.role === role)) {
    usageList = [
      ...usageList,
      {
        role,
        callsToday: 1,
        tokensToday: opts.tokens || 0,
        spendUsd: opts.costUsd || 0,
        rpmWindow: 1,
        lastCallAt: now,
      },
    ];
  }
  matrix.usage = usageList;
  await saveRoutingMatrix(matrix);

  const route = matrix.routes.find((r) => r.role === role);
  const u = matrix.usage.find((x) => x.role === role)!;
  const overRpm = route ? u.rpmWindow > route.rpmLimit : false;
  const overBudget = route ? u.spendUsd > route.dailyBudgetUsd : false;
  return {
    usage: u,
    throttled: overRpm || overBudget,
    reason: overRpm ? 'rpm' : overBudget ? 'budget' : null,
  };
}

export async function resetRoleUsage(): Promise<RoutingMatrix> {
  const matrix = await loadRoutingMatrix();
  matrix.usage = matrix.usage.map((u) => ({
    ...u,
    callsToday: 0,
    tokensToday: 0,
    spendUsd: 0,
    rpmWindow: 0,
    lastCallAt: undefined,
  }));
  rpmMap().clear();
  await saveRoutingMatrix(matrix);
  return refreshRpmWindows(matrix);
}
