/**
 * Engine Service — Unified server-side service layer for SwarmAgents.
 *
 * Instantiates all integrated utilities and provides a clean API
 * for Next.js routes to consume real agent engine functionality.
 */

import { AgentMetricsCollector, getMetricsCollector } from './agentMetrics';
import { CostTracker, getCostTracker } from './costTracker';
import { MemoryPersistence, getMemoryPersistence } from './memoryPersistence';
import { getLearningSystem } from './learningSystem';

// ─── Re-export singletons ───────────────────────────────────
export { getMetricsCollector, getCostTracker, getMemoryPersistence, getLearningSystem };

// ─── System snapshot for dashboard ──────────────────────────
export async function getSystemSnapshot() {
  const metrics = getMetricsCollector();
  const costs = getCostTracker();
  const persist = getMemoryPersistence();

  // Ensure persistence directory exists
  await persist.init();

  const snapshot = metrics.getSystemSnapshot();
  const costStats = costs.getStats();

  return {
    activeAgents: snapshot.global.activeAgents,
    tasksCompleted: snapshot.global.taskSuccessCount + snapshot.global.taskFailureCount,
    taskSuccessCount: snapshot.global.taskSuccessCount,
    taskFailureCount: snapshot.global.taskFailureCount,
    avgLatency: 0, // not tracked yet
    uptime: `${Math.floor((snapshot.global.uptime || 0) / 3600)}h ${Math.floor(((snapshot.global.uptime || 0) % 3600) / 60)}m`,
    totalTokens: snapshot.global.totalTokens,
    totalCost: costStats.totalCost,
    costByProvider: costStats.byProvider,
    agentDecisions: (snapshot.global.agentDecisions || []).slice(-10),
    toolUsage: snapshot.global.toolUsage || {},
    timestamp: Date.now(),
  };
}
