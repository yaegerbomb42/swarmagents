import { NextResponse } from "next/server";
import { orchestrator } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = orchestrator.getState();
  const healthy = state.agentHealth.filter((a) => a.status === "healthy").length;
  const total = state.agentHealth.length || 0;

  return NextResponse.json({
    status: state.lifecycle === "DEGRADED" ? "degraded" : total > 0 ? "active" : "idle",
    agentCount: total,
    activeTasks: state.tasks.filter((t) => t.status === "running").length,
    queuedTasks: state.queueDepth,
    completedTasks: state.tasks.filter((t) => t.status === "completed").length,
    uptimeSeconds: Math.round(process.uptime()),
    collectiveHealth: total > 0 ? +(healthy / total).toFixed(3) : 1,
    lifecycle: state.lifecycle,
    throughput: state.throughput,
    timestamp: Date.now(),
  });
}
