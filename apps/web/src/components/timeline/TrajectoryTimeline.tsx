'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Pause, SkipForward } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type TrajectoryStep = {
  id: string;
  label: string;
  detail?: string;
  energy?: number;
};

export type TrajectoryTimelineProps = {
  steps?: TrajectoryStep[];
  autoLoadDemo?: boolean;
  className?: string;
};

const DEMO_TRANSITIONS: Record<string, string[]> = {
  plan: ['edit', 'test'],
  edit: ['test', 'submit'],
  test: ['submit', 'plan'],
  submit: ['plan'],
};

function planToSteps(plan: { actions?: string[]; steps?: Array<{ action?: string; energy?: number }> }): TrajectoryStep[] {
  if (Array.isArray(plan.steps) && plan.steps.length) {
    return plan.steps.map((s, i) => ({
      id: `step-${i}`,
      label: String(s.action ?? `step-${i + 1}`),
      energy: typeof s.energy === 'number' ? s.energy : undefined,
    }));
  }
  const actions = plan.actions ?? [];
  return actions.map((label, i) => ({
    id: `step-${i}`,
    label: String(label),
    energy: i * 0.5,
  }));
}

export default function TrajectoryTimeline({
  steps: stepsProp,
  autoLoadDemo = false,
  className = '',
}: TrajectoryTimelineProps) {
  const [steps, setSteps] = useState<TrajectoryStep[]>(stepsProp ?? []);
  const [loading, setLoading] = useState(autoLoadDemo && !stepsProp?.length);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const loadDemo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await unifiedApi.hamiltonianPlan({
        start: 'plan',
        goal: 'submit',
        transitions: DEMO_TRANSITIONS,
        action_costs: { plan: 1, edit: 2, test: 1.5, submit: 0.5 },
      });
      const next = planToSteps(data.plan ?? {});
      setSteps(next);
      setIndex(0);
      setPlaying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trajectory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (stepsProp?.length) {
      setSteps(stepsProp);
      setIndex(0);
      setPlaying(false);
      return;
    }
    if (autoLoadDemo) void loadDemo();
  }, [autoLoadDemo, loadDemo, stepsProp]);

  const maxIndex = Math.max(0, steps.length - 1);
  const current = steps[index];

  useEffect(() => {
    if (!playing || index >= maxIndex) {
      if (playing && index >= maxIndex) setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setIndex((i) => Math.min(i + 1, maxIndex)), 800);
    return () => window.clearTimeout(id);
  }, [playing, index, maxIndex]);

  const progressPct = useMemo(
    () => (steps.length ? ((index + 1) / steps.length) * 100 : 0),
    [index, steps.length],
  );

  return (
    <section
      data-testid="trajectory-timeline"
      className={`rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 ${className}`}
      aria-label="Agent trajectory playback"
    >
      {loading ? (
        <p className="text-[10px] text-zinc-500 font-mono">loading trajectory…</p>
      ) : error ? (
        <p className="text-[10px] text-rose-300/80 font-mono">{error}</p>
      ) : !current ? (
        <p className="text-[11px] text-zinc-400">No trajectory recorded yet.</p>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setIndex((i) => Math.min(maxIndex, i + 1));
            }}
            disabled={index >= maxIndex}
            className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors disabled:opacity-30"
            aria-label="Next step"
          >
            <SkipForward className="h-3 w-3" />
          </button>

          <span className="shrink-0 text-[9.5px] font-mono text-zinc-500 tabular-nums">
            {index + 1} / {steps.length} steps
          </span>

          <div className="flex-1 min-w-0 flex items-center gap-0 overflow-hidden">
            {steps.map((step, i) => (
              <div key={step.id} className="flex items-center min-w-0">
                {i > 0 && (
                  <span
                    aria-hidden
                    className={`h-px w-3 shrink-0 ${i <= index ? 'bg-cyan-400/40' : 'bg-white/10'}`}
                  />
                )}
                <button
                  type="button"
                  data-testid={`trajectory-step-${i}`}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(i);
                  }}
                  title={typeof step.energy === 'number' ? `${step.label} · E=${step.energy.toFixed(2)}` : step.label}
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8.5px] font-mono uppercase tracking-wide transition-colors ${
                    i === index
                      ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200'
                      : i < index
                        ? 'border-transparent text-zinc-400 hover:text-zinc-200'
                        : 'border-transparent text-zinc-600 hover:text-zinc-400'
                  }`}
                >
                  {step.label}
                </button>
              </div>
            ))}
          </div>

          <span
            aria-hidden
            className="shrink-0 h-1 w-10 rounded-full bg-white/5 overflow-hidden hidden sm:block"
          >
            <span
              className="block h-full bg-cyan-400/70 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </span>
        </div>
      )}
    </section>
  );
}
