'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Clock,
  Command,
  Cpu,
  Layers,
  Radio,
  Rocket,
  Workflow,
  X,
} from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';
import type { HierarchyAgent } from '@/lib/swarmHierarchy';
import { openOmnibar } from '@/lib/omnibar';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { planToHamiltonianGraph } from '@/components/quantum/HamiltonianViz';
import type { CheckpointPhase } from '@/components/mission/MissionCheckpointBar';

const SwarmCanvas3D = dynamic(() => import('@/components/topology/SwarmCanvas3D'), { ssr: false });
const TrajectoryTimeline = dynamic(() => import('@/components/timeline/TrajectoryTimeline'), { ssr: false });
const HamiltonianViz = dynamic(() => import('@/components/quantum/HamiltonianViz'), { ssr: false });
const LiveLogStreamTerminal = dynamic(() => import('@/components/logs/LiveLogStreamTerminal'), { ssr: false });
const AgentHealthMatrixCard = dynamic(() => import('@/components/fleet/AgentHealthMatrixCard'), { ssr: false });
const WorkerHeatmap = dynamic(() => import('@/components/fleet/WorkerHeatmap'), { ssr: false });
const MissionCheckpointBar = dynamic(() => import('@/components/mission/MissionCheckpointBar'), {
  ssr: false,
});

export type LaunchSnapshot = {
  ok: boolean;
  readiness_pct: number;
  status: string;
  generated_at: string;
  telemetry: {
    workers_active: number;
    queue_depth: number;
    mode: string;
    modal_apps: number;
  };
  fleet: {
    counts: { pending: number; completed: number; blocked: number };
    next_pending: Array<{ id: string; title: string; priority: number }>;
    active_locks: Array<{ worker_id: string; file_path: string }>;
  };
  missions: Array<{
    id: string;
    label: string;
    budget: string;
    description: string;
    href: string;
  }>;
};

const DEMO_AGENTS: HierarchyAgent[] = [
  {
    id: 'architect',
    roleId: 'architect',
    parentId: null,
    status: 'running',
    label: 'Chief Architect',
    activity: 'communicating',
    live: true,
    assignedModel: 'deepseek-v4',
  },
  {
    id: 'w1',
    roleId: 'implementer',
    parentId: 'architect',
    status: 'running',
    label: 'Worker Alpha',
    activity: 'working',
    live: true,
    assignedModel: 'qwen-27b',
  },
  {
    id: 'w2',
    roleId: 'implementer',
    parentId: 'architect',
    status: 'running',
    label: 'Worker Beta',
    activity: 'working',
    live: true,
    assignedModel: 'mistral-large',
  },
  {
    id: 'verifier',
    roleId: 'verifier',
    parentId: 'architect',
    status: 'idle',
    label: 'Verifier',
    activity: 'idle',
    live: true,
    assignedModel: 'ep-gemma-4',
  },
  {
    id: 'researcher',
    roleId: 'researcher',
    parentId: 'architect',
    status: 'running',
    label: 'Scout',
    activity: 'communicating',
    live: true,
  },
];

const FALLBACK_STEPS = ['plan', 'decompose', 'execute', 'verify', 'ship'];

function Metric({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  hint?: string;
}) {
  const numeric = typeof value === 'number' ? value : null;
  const animated = useAnimatedNumber(numeric ?? 0);
  const display = numeric !== null ? animated : value;

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2 text-micro uppercase text-zinc-500">
        <Icon className="h-3 w-3 text-cyan-400/80" aria-hidden />
        {label}
      </div>
      <p className="mt-1 text-lg font-medium tabular-nums tracking-tight text-zinc-100">{display}</p>
      {hint ? <p className="text-meta text-zinc-600 truncate">{hint}</p> : null}
    </div>
  );
}

function StatusBadge({
  live,
  children,
}: {
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-meta font-medium tabular-nums text-zinc-400">
      {live ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent-wash" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

export default function SwarmCommandCenter() {
  const [snapshot, setSnapshot] = useState<LaunchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>('architect');
  const [consensusOk, setConsensusOk] = useState<boolean | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointPhase[]>([]);
  const [hamiltonianActions, setHamiltonianActions] = useState<string[]>([]);
  const [totalEnergy, setTotalEnergy] = useState<number | undefined>();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [launch, consensus, mission, plan] = await Promise.all([
        unifiedApi.launchSnapshot(),
        unifiedApi.groupchatConsensus().catch(() => null),
        unifiedApi.missionSnapshot().catch(() => null),
        unifiedApi
          .hamiltonianPlan({
            start: 'plan',
            goal: 'ship',
            transitions: {
              plan: ['code', 'test'],
              code: ['test', 'review'],
              test: ['review', 'ship'],
              review: ['ship'],
              ship: ['plan'],
            },
            action_costs: { plan: 1, code: 2.5, test: 1.5, review: 1, ship: 0.5 },
          })
          .catch(() => null),
      ]);
      setSnapshot(launch);
      setConsensusOk(consensus?.consensus?.accepted === true);
      if (mission?.checkpoints?.length) {
        setCheckpoints(mission.checkpoints as CheckpointPhase[]);
      }
      if (plan?.plan?.actions?.length) {
        setHamiltonianActions(plan.plan.actions);
        setTotalEnergy(plan.plan.total_energy);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Command center offline');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      setSelectedTaskId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const readiness = snapshot?.readiness_pct ?? 0;
  const statusLabel = snapshot?.status === 'launch_ready' ? 'LAUNCH READY' : 'WARMING UP';
  const topTasks = useMemo(
    () => snapshot?.fleet.next_pending ?? [],
    [snapshot?.fleet.next_pending],
  );
  const selectedTask = topTasks.find((task) => task.id === selectedTaskId) ?? null;
  const steps = hamiltonianActions.length ? hamiltonianActions : FALLBACK_STEPS;

  const hamiltonianGraph = useMemo(
    () => planToHamiltonianGraph(hamiltonianActions, Math.max(0, hamiltonianActions.length - 1)),
    [hamiltonianActions],
  );

  return (
    <div data-testid="swarm-command-center" className="flex min-h-0 flex-col gap-3 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/[0.06] pb-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-micro font-medium uppercase text-zinc-500">
              SwarmAgents
            </span>
            <StatusBadge live>{statusLabel}</StatusBadge>
            {consensusOk !== null ? (
              <StatusBadge>{consensusOk ? 'Consensus accepted' : 'Deliberating'}</StatusBadge>
            ) : null}
            <StatusBadge>
              {snapshot?.telemetry.workers_active ?? '—'} workers · {snapshot?.telemetry.queue_depth ?? '—'} queued
            </StatusBadge>
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-50 md:text-xl">
            Mission Command Center
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] text-meta font-medium tabular-nums text-cyan-300"
            aria-label={`${readiness}%`}
          >
            {readiness}%
          </div>
          <button
            type="button"
            onClick={openOmnibar}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-meta text-zinc-400 hover:text-zinc-100"
            title="Command palette (Cmd+K)"
          >
            <Command className="h-3 w-3" />
            <kbd className="font-mono text-meta">⌘K</kbd>
          </button>
          <Link
            href="/decomp"
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-400 px-3 py-1.5 text-meta font-medium text-zinc-950 hover:bg-cyan-300"
          >
            <Rocket className="h-3.5 w-3.5" />
            Launch Decomposition
          </Link>
          <Link
            href="/decomp/fleet?tab=mission"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-meta text-zinc-300 hover:bg-white/[0.04]"
          >
            Fleet Mission Control
          </Link>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}

      {checkpoints.length > 0 ? <MissionCheckpointBar phases={checkpoints} /> : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric icon={Cpu} label="Active Workers" value={snapshot?.telemetry.workers_active ?? '—'} hint="File-lock leases" />
        <Metric
          icon={Layers}
          label="Queue Depth"
          value={snapshot?.telemetry.queue_depth ?? '—'}
          hint={snapshot?.telemetry.mode?.replace('_', ' ') ?? 'fleet mode'}
        />
        <Metric icon={Activity} label="Completed" value={snapshot?.fleet.counts.completed ?? '—'} hint="Shipped tasks" />
        <Metric icon={Radio} label="Modal Apps" value={snapshot?.telemetry.modal_apps ?? '—'} hint="Cloud inference" />
      </div>

      <div className="grid min-h-[26rem] grid-cols-1 gap-3 xl:grid-cols-12">
        <section className="flex min-h-[22rem] flex-col overflow-hidden rounded-md border border-white/[0.06] bg-[#080a12]/80 xl:col-span-7">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5">
            <span className="text-meta font-medium text-zinc-300">Live execution</span>
            <button
              type="button"
              onClick={() => setShowDiagnostics((v) => !v)}
              aria-pressed={showDiagnostics}
              className={`rounded-xs border border-line-2 px-2 py-0.5 text-micro transition-colors duration-fast ease-out ${showDiagnostics ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:text-fg-1'}`}
            >
              Diagnostics
            </button>
          </div>
          <div className="min-h-[20rem] flex-1">
            <ol className="h-full space-y-1.5 overflow-y-auto p-3 font-mono text-xs">
                <li className="mb-2 flex items-center justify-between text-meta text-zinc-500">
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    <Workflow className="h-3 w-3" />
                    Execution nodes
                  </span>
                  <span>{steps.length} steps</span>
                </li>
                {steps.map((act, idx) => (
                  <li
                    key={`${act}-${idx}`}
                    className="flex items-center gap-2 rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1.5"
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/[0.08] text-meta text-zinc-400">
                      {idx + 1}
                    </span>
                    <span className="flex-1 capitalize text-zinc-200">{act}</span>
                    <span className="inline-flex items-center gap-1 text-meta text-zinc-500">
                      <Clock className="h-2.5 w-2.5" />
                      {(idx * 1.8 + 0.5).toFixed(1)}s
                    </span>
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
                  </li>
                ))}
              </ol>
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-3 xl:col-span-5">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex min-h-[12rem] flex-col overflow-hidden rounded-md border border-white/[0.06]">
              <div className="border-b border-white/[0.06] px-3 py-1.5 text-micro uppercase text-zinc-500">
                Fleet queue
              </div>
              <ul className="flex-1 overflow-y-auto p-1.5">
                {topTasks.length ? (
                  topTasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedTaskId(task.id)}
                        className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.04] ${
                          selectedTaskId === task.id ? 'bg-white/[0.06]' : ''
                        }`}
                      >
                        <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
                        <span className="min-w-0">
                          <span className="block font-mono text-meta text-zinc-500">{task.id}</span>
                          <span className="block truncate text-meta text-zinc-200">{task.title}</span>
                          <span className="block text-meta text-zinc-600">priority {task.priority}</span>
                        </span>
                      </button>
                    </li>
                  ))
                ) : (
                  <li className="px-2 py-3 text-xs text-zinc-500">Queue empty — ideation mode</li>
                )}
              </ul>
            </div>

            <div
              className={`rounded-md border border-white/[0.06] p-3 ${
                selectedTask ? 'fixed inset-x-3 bottom-3 z-30 bg-[#080a12] shadow-xl md:static md:z-auto md:shadow-none' : ''
              }`}
              hidden={!selectedTask}
              data-testid="queue-detail"
            >
              {selectedTask ? (
                <>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-mono text-meta text-zinc-500">{selectedTask.id}</p>
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(null)}
                      className="rounded p-1 text-zinc-500 hover:text-zinc-200"
                      aria-label="Dismiss task detail"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-sm text-zinc-100">{selectedTask.title}</p>
                  <p className="mt-1 text-meta text-zinc-500">Priority {selectedTask.priority}</p>
                  <p className="mt-2 text-meta text-zinc-600">Esc to dismiss</p>
                </>
              ) : null}
            </div>
          </div>

          <TrajectoryTimeline className="min-h-[8rem]" />
          <LiveLogStreamTerminal className="min-h-[10rem] shrink-0" defaultExpanded />
        </section>
      </div>

      {showDiagnostics ? (
        <section aria-label="Diagnostics" data-testid="command-diagnostics" className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="min-h-[20rem] overflow-hidden rounded-r-md border border-line-2 bg-bg-1">
            <SwarmCanvas3D
              agents={DEMO_AGENTS}
              connected
              selectedAgentId={selectedAgent}
              onSelectAgent={setSelectedAgent}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            {hamiltonianActions.length > 0 ? (
              <HamiltonianViz
                nodes={hamiltonianGraph.nodes}
                edges={hamiltonianGraph.edges}
                activeNodeId={hamiltonianActions[hamiltonianActions.length - 1]}
                totalEnergy={totalEnergy}
                className="min-h-[9rem]"
              />
            ) : null}
            <AgentHealthMatrixCard className="min-h-[8rem]" refreshMs={5000} />
            <WorkerHeatmap />
          </div>
        </section>
      ) : null}

      <section aria-label="Launch missions">
        <h2 className="mb-2 text-micro font-medium uppercase text-zinc-500">
          Curated launch missions
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(snapshot?.missions ?? []).map((mission) => (
            <Link
              key={mission.id}
              href={mission.href}
              className="group rounded-md border border-white/[0.06] bg-white/[0.02] p-3 hover:border-cyan-400/25 hover:bg-white/[0.04]"
            >
              <p className="text-meta font-mono text-zinc-500">{mission.budget}</p>
              <p className="mt-0.5 text-sm font-medium text-zinc-100">{mission.label}</p>
              <p className="mt-1 text-meta leading-relaxed text-zinc-500">{mission.description}</p>
              <p className="mt-2 text-meta font-mono text-cyan-400/80 group-hover:text-cyan-300">Launch →</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
