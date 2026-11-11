"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Brain, CheckCircle2, Clock, GitBranch, Loader2, Play, RefreshCw, Sparkles, Zap } from "lucide-react";
import TaskInput from "@/components/TaskInput";
import SiteHeader from "@/components/SiteHeader";
import TaskTreeVisualization from "@/components/TaskTreeVisualization";
import NodeDetailPanel from "@/components/NodeDetailPanel";
import { useDecomposition, useNodeSelection } from "@/hooks/useDecomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import { TaskStatus, TaskType } from "@/types/decomposition";

const formatHours = (hours: number) => {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
};

export default function DecompositionWorkbench() {
  const router = useRouter();
  const {
    projectId,
    tree,
    isProcessing,
    isConnected,
    error,
    startDecomposition,
    refreshTree,
    reset,
    downloadDeliverable,
  } = useDecomposition();
  const { selectedNodeId, selectNode } = useNodeSelection();
  const [isExecuting, setIsExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    decompositionApi
      .healthCheck()
      .then(() => mounted && setEngineOnline(true))
      .catch(() => mounted && setEngineOnline(false));
    return () => {
      mounted = false;
    };
  }, []);

  const stats = useMemo(() => {
    if (!tree) {
      return {
        topics: 0,
        leaves: 0,
        readyLeaves: 0,
        active: 0,
        completed: 0,
        progress: 0,
      };
    }

    const nodes = Object.values(tree.nodes);
    const leaves = nodes.filter((node) => node.type === TaskType.LEAF);
    const completed = nodes.filter((node) => node.status === TaskStatus.COMPLETED).length;
    const active = nodes.filter((node) =>
      [TaskStatus.DECOMPOSING, TaskStatus.ASSIGNED, TaskStatus.EXECUTING, TaskStatus.VALIDATING].includes(node.status)
    ).length;

    return {
      topics: nodes.filter((node) => node.depth <= 1).length,
      leaves: leaves.length,
      readyLeaves: leaves.filter((node) => [TaskStatus.READY, TaskStatus.PENDING].includes(node.status)).length,
      active,
      completed,
      progress: nodes.length ? (completed / nodes.length) * 100 : 0,
    };
  }, [tree]);

  const handleExecute = async () => {
    if (!projectId) return;
    try {
      setIsExecuting(true);
      setActionError(null);
      await decompositionApi.executeProject(projectId);
      await refreshTree();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start execution");
    } finally {
      setIsExecuting(false);
    }
  };

  const totalHours = tree ? tree.total_time_budget / 3600 : 0;
  const consumedHours = tree ? tree.time_consumed / 3600 : 0;

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <SiteHeader subtitle="Project decomposition workbench" />
      <div className="mx-auto flex max-w-[1800px] flex-col gap-6 px-5 py-6 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-cyan-400/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1 text-xs font-mono text-cyan-200">
              <Brain className="h-3.5 w-3.5" />
              DeepSeek Architect → 5GB Worker Leaves
            </div>
            <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
              Project Decomposition Tree
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-cyan-100/55 md:text-base">
              Enter a large goal and time requirement. Azure DeepSeek builds a branching plan, keeps splitting until
              leaves are manageable for small local workers, then validates and merges branch outputs into the final artifact.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {projectId && (
              <button
                onClick={() => router.push(`/dashboard/${projectId}`)}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-400/10"
              >
                Open Detail View
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={reset}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white"
            >
              <RefreshCw className="h-4 w-4" />
              New Project
            </button>
          </div>
        </header>

        <TaskInput
          layout="embedded"
          isProcessing={isProcessing}
          onSubmit={startDecomposition}
        />

        {(error || actionError) && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" />
              <span>{actionError || error?.message}</span>
            </div>
          </div>
        )}

        {engineOnline === false && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            Can’t reach the decomposition service right now. You can still enter a project — retry in a moment if the first request fails.
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "Top Topics", value: stats.topics, icon: GitBranch },
            { label: "Worker Leaves", value: stats.leaves, icon: Sparkles },
            { label: "Ready Leaves", value: stats.readyLeaves, icon: Zap },
            { label: "Active Branches", value: stats.active, icon: Loader2 },
            { label: "Completed", value: stats.completed, icon: CheckCircle2 },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between text-cyan-100/50">
                <span className="text-xs font-mono uppercase tracking-[0.18em]">{label}</span>
                <Icon className="h-4 w-4" />
              </div>
              <div className="text-3xl font-semibold text-white">{value}</div>
            </div>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-4">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Live Decomposition Graph</h2>
                <p className="text-sm text-white/45">
                  Big topics remain near the top; leaves at the bottom are worker-sized execution tasks.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${isConnected ? "bg-green-500/10 text-green-300" : "bg-white/5 text-white/40"}`}>
                  <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-green-400" : "bg-white/30"}`} />
                  {isConnected ? "Live" : "Ready"}
                </span>
                <button
                  disabled={!projectId || isExecuting}
                  onClick={handleExecute}
                  className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Run Branches
                </button>
              </div>
            </div>

            {tree ? (
              <TaskTreeVisualization
                tree={tree}
                selectedNodeId={selectedNodeId}
                onNodeSelect={selectNode}
              />
            ) : (
              <div className="flex h-[600px] items-center justify-center rounded-xl border border-dashed border-cyan-400/20 bg-black/20">
                <div className="max-w-md text-center">
                  <Clock className="mx-auto mb-4 h-10 w-10 text-cyan-300/50" />
                  <h3 className="text-lg font-medium">No tree yet</h3>
                  <p className="mt-2 text-sm text-white/45">
                    Submit a project above to start recursive decomposition.
                  </p>
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200/70">Time Budget</h3>
              <div className="mb-3 flex items-end justify-between">
                <span className="text-3xl font-semibold">{formatHours(consumedHours)}</span>
                <span className="text-sm text-white/45">of {formatHours(totalHours || 0)}</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-cyan-400 transition-all"
                  style={{ width: `${Math.min(100, totalHours ? (consumedHours / totalHours) * 100 : 0)}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-white/40">
                If time remains after a branch completes, the system can refine, robustify, or add quality passes.
              </p>
            </div>

            <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200/70">Execution Policy</h3>
              <ul className="space-y-3 text-sm text-white/55">
                <li>DeepSeek decomposes, verifies, and merges.</li>
                <li>Worker leaves are constrained to small-model scope.</li>
                <li>Branches can stop, split, retry, or improve independently.</li>
                <li>The final deliverable forms at the bottom of completed branches.</li>
              </ul>
            </div>

            {tree && (
              <button
                onClick={() => projectId && downloadDeliverable(tree.root_node_id)}
                className="w-full rounded-xl border border-white/10 px-4 py-3 text-sm text-white/70 hover:bg-white/5"
              >
                Download Final Artifact
              </button>
            )}
          </aside>
        </section>
      </div>

      {projectId && selectedNodeId && tree && (
        <NodeDetailPanel
          projectId={projectId}
          nodeId={selectedNodeId}
          tree={tree}
          onClose={() => selectNode(null)}
          onRefresh={() => void refreshTree()}
        />
      )}
    </div>
  );
}
