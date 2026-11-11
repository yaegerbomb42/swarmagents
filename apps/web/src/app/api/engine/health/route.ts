import { NextRequest, NextResponse } from 'next/server';
import { orchestrator } from '@/lib/orchestrator';
import { getSystemSnapshot } from '@/lib/engine-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

export async function GET(req: NextRequest) {
  // Try remote Python engine first
  try {
    const res = await fetch(`${ENGINE_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Engine returned ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    // Fall through to in-process engine
  }

  // Use in-process orchestrator + metrics for live data
  try {
    const snap = await getSystemSnapshot();
    const orchState = orchestrator.getState();

    const healthyAgents = orchState.agentHealth.filter(
      (a) => a.status === 'healthy'
    ).length;
    const totalAgents = orchState.agentHealth.length || snap.activeAgents || 0;

    const tasksCompleted = orchState.tasks.filter(
      (t) => t.status === 'completed'
    ).length + snap.taskSuccessCount;
    const tasksFailed = orchState.tasks.filter(
      (t) => t.status === 'failed'
    ).length + snap.taskFailureCount;
    const tasksRunning = orchState.tasks.filter(
      (t) => t.status === 'running'
    ).length;
    const tasksQueued = orchState.queueDepth;

    const uptimeSeconds = process.uptime();
    const hrs = Math.floor(uptimeSeconds / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const secs = Math.floor(uptimeSeconds % 60);
    const uptimeHuman = hrs > 0
      ? `${hrs}h ${mins}m`
      : mins > 0
        ? `${mins}m ${secs}s`
        : `${secs}s`;

    const avgLatency = orchState.avgLatency || 0;

    return NextResponse.json({
      status: totalAgents > 0 && healthyAgents / (totalAgents || 1) > 0.5
        ? 'healthy'
        : totalAgents === 0
          ? 'idle'
          : 'degraded',
      active_agents: healthyAgents || totalAgents,
      total_agents: totalAgents,
      tasks_queued: tasksQueued,
      tasks_running: tasksRunning,
      tasks_completed: tasksCompleted,
      tasks_failed: tasksFailed,
      avg_latency_ms: Math.round(avgLatency),
      uptime_seconds: Math.round(uptimeSeconds),
      uptime_human: uptimeHuman,
      llm_local_calls: 0,
      llm_cloud_calls: 0,
      models_available: [
        'deepseek-v4-flash',
        'swarmagent-core-16.9b',
        'swarmagent-router-16.9b',
        'qwen3-hamiltonian',
        'llama3.3',
      ],
      orchestrator_lifecycle: orchState.lifecycle,
      throughput: orchState.throughput,
      total_cost: snap.totalCost,
      total_tokens: snap.totalTokens,
    });
  } catch (e) {
    return NextResponse.json({
      status: 'degraded',
      active_agents: 0,
      total_agents: 0,
      tasks_queued: 0,
      tasks_running: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      avg_latency_ms: 0,
      uptime_seconds: 0,
      uptime_human: '0s',
      llm_local_calls: 0,
      llm_cloud_calls: 0,
      models_available: ['deepseek-v4-flash'],
      engine_error: String(e),
    });
  }
}
