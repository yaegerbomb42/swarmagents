'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Rocket, RefreshCw } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';
import MissionCheckpointBar, { type CheckpointPhase } from './MissionCheckpointBar';
import HamiltonianViz, { planToHamiltonianGraph } from '@/components/quantum/HamiltonianViz';
import type { TrajectoryStep } from '@/components/timeline/TrajectoryTimeline';

const TrajectoryTimeline = dynamic(() => import('@/components/timeline/TrajectoryTimeline'), {
  ssr: false,
});
const FleetTerminal = dynamic(() => import('@/components/terminal/FleetTerminal'), { ssr: false });
const PtyTerminal = dynamic(() => import('@/components/terminal/PtyTerminal'), { ssr: false });
const MissionTerminalFeed = dynamic(() => import('./MissionTerminalFeed'), { ssr: false });
const WorkerHeatmap = dynamic(() => import('@/components/fleet/WorkerHeatmap'), { ssr: false });
const HoloStatusBar = dynamic(() => import('@/components/ui/holo-status-bar'), { ssr: false });
const SwarmPulseTicker = dynamic(() => import('./SwarmPulseTicker'), { ssr: false });
const ConsensusReplay = dynamic(() => import('@/components/swarm/ConsensusReplay'), { ssr: false });
const LogViewer = dynamic(() => import('@/components/logs/LogViewer'), { ssr: false });
const VoiceBriefing = dynamic(() => import('@/components/audio/VoiceBriefing'), { ssr: false });
const FleetTaskTree = dynamic(() => import('@/components/fleet/FleetTaskTree'), { ssr: false });

const DEMO_TRANSITIONS: Record<string, string[]> = {
  plan: ['code', 'test'],
  code: ['test', 'review'],
  test: ['review', 'ship'],
  review: ['ship'],
  ship: ['plan'],
};

const DEFAULT_CHECKPOINTS: CheckpointPhase[] = [
  { id: 'plan', label: 'Plan', status: 'active' },
  { id: 'implement', label: 'Implement', status: 'pending' },
  { id: 'verify', label: 'Verify', status: 'pending' },
  { id: 'ship', label: 'Ship', status: 'pending' },
];

function stepsFromPlan(plan: { actions?: string[]; steps?: Array<{ action?: string; energy?: number }> }): TrajectoryStep[] {
  if (plan.steps?.length) {
    return plan.steps.map((s, i) => ({
      id: `s-${i}`,
      label: String(s.action ?? `step-${i}`),
      energy: typeof s.energy === 'number' ? s.energy : undefined,
    }));
  }
  return (plan.actions ?? []).map((label, i) => ({
    id: `s-${i}`,
    label: String(label),
    energy: i * 0.5,
  }));
}

export type MissionControlProps = {
  className?: string;
};

export default function MissionControl({ className = '' }: MissionControlProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointPhase[]>(DEFAULT_CHECKPOINTS);
  const [steps, setSteps] = useState<TrajectoryStep[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [totalEnergy, setTotalEnergy] = useState<number | undefined>();
  const [mode, setMode] = useState('—');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snap, planRes] = await Promise.all([
        unifiedApi.missionSnapshot(),
        unifiedApi.hamiltonianPlan({
          start: 'plan',
          goal: 'ship',
          transitions: DEMO_TRANSITIONS,
          action_costs: { plan: 1, code: 2.5, test: 1.5, review: 1, ship: 0.5 },
        }),
      ]);
      setCheckpoints(snap.checkpoints as CheckpointPhase[]);
      setMode(snap.launch_mode);
      const nextSteps = stepsFromPlan(planRes.plan ?? {});
      setSteps(nextSteps);
      setTotalEnergy(planRes.plan?.total_energy);
      setActiveIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mission Control sync failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15000);
    return () => clearInterval(id);
  }, [refresh]);

  const actions = useMemo(() => steps.map((s) => s.label), [steps]);
  const graph = useMemo(
    () => planToHamiltonianGraph(actions, activeIndex),
    [actions, activeIndex],
  );

  return (
    <div
      data-testid="mission-control"
      className={`flex flex-col gap-3 h-full min-h-0 ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-cyan-400" aria-hidden />
          <div>
            <h1 className="text-sm font-semibold text-white/95 tracking-tight">Mission Control</h1>
            <p className="text-[10px] text-zinc-500">
              Hamiltonian trajectories · fleet terminal · live worker telemetry
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-purple-300/80 px-2 py-0.5 rounded border border-purple-500/20 bg-purple-500/5">
            {mode}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="tactile-icon p-1.5 text-zinc-400 hover:text-cyan-300"
            aria-label="Refresh mission control"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <HoloStatusBar className="shrink-0" />

      {error ? (
        <div className="text-xs text-rose-300 px-1">{error}</div>
      ) : (
        <MissionCheckpointBar phases={checkpoints} />
      )}

      <SwarmPulseTicker className="shrink-0" />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-3 min-h-0">
          <HamiltonianViz
            nodes={graph.nodes}
            edges={graph.edges}
            activeNodeId={actions[activeIndex]}
            totalEnergy={totalEnergy}
            className="flex-1 min-h-[12rem]"
          />
          <TrajectoryTimeline
            steps={steps}
            autoLoadDemo={false}
            className="shrink-0"
          />
        </div>

        <div className="flex flex-col gap-3 min-h-0">
          <PtyTerminal className="flex-1 min-h-[12rem]" />
          <FleetTerminal className="shrink-0 max-h-40" />
          <MissionTerminalFeed className="shrink-0 max-h-32" />
          <LogViewer className="shrink-0 max-h-36" />
          <ConsensusReplay autoFetch className="shrink-0 max-h-40" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 shrink-0">
        <VoiceBriefing />
        <FleetTaskTree />
      </div>

      <WorkerHeatmap refreshIntervalMs={10000} className="shrink-0" />
    </div>
  );
}
