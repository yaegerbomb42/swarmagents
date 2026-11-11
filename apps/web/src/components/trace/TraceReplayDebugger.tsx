'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  GitFork,
  FastForward,
  Clock,
  Zap,
  Activity,
  CheckCircle2,
  AlertCircle,
  Code2,
  Terminal,
  Cpu,
  Layers,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import type { SandboxAction } from '@/lib/sandboxTypes';

export interface TraceStepState {
  stepIndex: number;
  timestamp: number;
  action: string;
  category: 'tool' | 'thought' | 'exec' | 'state' | 'checkpoint';
  status: 'success' | 'running' | 'failed';
  durationMs: number;
  tokensUsed: number;
  memoryMb: number;
  stateDiff?: {
    key: string;
    before: string;
    after: string;
  }[];
  outputPreview?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface TraceReplayDebuggerProps {
  initialSteps?: TraceStepState[];
  currentAgentLabel?: string;
  onForkRun?: (stepIndex: number, modifiedState?: Record<string, any>) => void;
  className?: string;
}

/** Demo fixture for tests/stories only — never used as a runtime default. */
export const DEFAULT_TRACE_STEPS: TraceStepState[] = [
  {
    stepIndex: 0,
    timestamp: Date.now() - 45000,
    action: 'mission_init: decomposition_planner',
    category: 'checkpoint',
    status: 'success',
    durationMs: 120,
    tokensUsed: 420,
    memoryMb: 84,
    stateDiff: [
      { key: 'mission.status', before: 'idle', after: 'planning' },
      { key: 'active_workers', before: '0', after: '4' },
    ],
    outputPreview: 'Sub-agent task graphs decomposed into 4 topological phases.',
  },
  {
    stepIndex: 1,
    timestamp: Date.now() - 32000,
    action: 'hamiltonian_decide: evaluate_next_step',
    category: 'thought',
    status: 'success',
    durationMs: 450,
    tokensUsed: 1250,
    memoryMb: 92,
    stateDiff: [
      { key: 'energy.H', before: '14.2', after: '8.7' },
      { key: 'candidate_action', before: 'null', after: 'read_ast_tree' },
    ],
    outputPreview: 'Selected path with minimum estimated latency and optimal AST cohesion.',
  },
  {
    stepIndex: 2,
    timestamp: Date.now() - 21000,
    action: 'tool_exec: read_ast_tree(path="src/components/CommandPalette.tsx")',
    category: 'tool',
    status: 'success',
    durationMs: 280,
    tokensUsed: 2100,
    memoryMb: 110,
    stateDiff: [
      { key: 'context.files_loaded', before: '1', after: '2' },
      { key: 'router_guard_present', before: 'false', after: 'true' },
    ],
    outputPreview: 'AST parsed successfully. Component exports 1 root with 4 command groups.',
  },
  {
    stepIndex: 3,
    timestamp: Date.now() - 11000,
    action: 'atomic_file_edit: patch_fencing_token(lease="lock_mu7v_81")',
    category: 'exec',
    status: 'success',
    durationMs: 640,
    tokensUsed: 3400,
    memoryMb: 124,
    stateDiff: [
      { key: 'fencing_seq', before: '80', after: '81' },
      { key: 'patch.applied', before: 'false', after: 'true' },
    ],
    outputPreview: 'Acquired write lock with fencing token 81; applied atomic diff cleanly.',
  },
  {
    stepIndex: 4,
    timestamp: Date.now() - 2000,
    action: 'verify_test_suite: vitest run',
    category: 'checkpoint',
    status: 'success',
    durationMs: 1420,
    tokensUsed: 520,
    memoryMb: 140,
    stateDiff: [
      { key: 'test_pass_rate', before: '414/414', after: '417/417' },
      { key: 'typecheck_status', before: 'pass', after: 'pass' },
    ],
    outputPreview: 'All 82 test suites passing (417 tests green). Zero TypeScript errors.',
  },
];

const EMPTY_STEPS: TraceStepState[] = [];

export default function TraceReplayDebugger({
  initialSteps = EMPTY_STEPS,
  currentAgentLabel = '—',
  onForkRun,
  className = '',
}: TraceReplayDebuggerProps) {
  const [steps, setSteps] = useState<TraceStepState[]>(initialSteps);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(
    initialSteps.length > 0 ? initialSteps.length - 1 : 0
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [forkModalOpen, setForkModalOpen] = useState<boolean>(false);
  const [forkPrompt, setForkPrompt] = useState<string>('');
  const [forkSuccessNotice, setForkSuccessNotice] = useState<string | null>(null);

  // Sync if initialSteps update
  useEffect(() => {
    if (initialSteps && initialSteps.length > 0) {
      setSteps(initialSteps);
      setCurrentStepIndex(initialSteps.length - 1);
    }
  }, [initialSteps]);

  const activeStep = useMemo(() => {
    return steps[currentStepIndex] || null;
  }, [steps, currentStepIndex]);

  // Trajectory scrubber playback loop
  useEffect(() => {
    if (!isPlaying) return;

    const intervalTime = Math.max(250, 1200 / playbackSpeed);
    const timer = setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= steps.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [isPlaying, playbackSpeed, steps.length]);

  const handleSeek = (index: number) => {
    setIsPlaying(false);
    setCurrentStepIndex(Math.max(0, Math.min(index, steps.length - 1)));
  };

  const handleFork = () => {
    if (onForkRun) {
      onForkRun(currentStepIndex, { forkPrompt, timestamp: Date.now() });
    }
    setForkSuccessNotice(`Forked mission trajectory from Step #${currentStepIndex + 1}!`);
    setForkModalOpen(false);
    setTimeout(() => setForkSuccessNotice(null), 4000);
  };

  const getCategoryBadgeClass = (category: TraceStepState['category']) => {
    switch (category) {
      case 'tool':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'thought':
        return 'bg-purple-500/10 text-purple-300 border-purple-500/30';
      case 'exec':
        return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30';
      case 'checkpoint':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      default:
        return 'bg-zinc-800 text-zinc-300 border-zinc-700';
    }
  };

  if (steps.length === 0) {
    return (
      <div
        data-testid="trace-replay-debugger"
        className={`rounded-2xl border border-white/[0.08] bg-[#07090E]/90 p-6 flex flex-col gap-2 text-zinc-200 ${className}`}
      >
        <span className="font-semibold text-xs tracking-wide text-zinc-100">Trace Replay</span>
        <p data-testid="trace-empty-state" className="text-[12px] text-zinc-400">
          No recorded trace steps for {currentAgentLabel === '—' ? 'this agent' : currentAgentLabel} yet.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="trace-replay-debugger"
      className={`rounded-2xl border border-white/[0.08] bg-[#07090E]/90 backdrop-blur-xl shadow-2xl p-4 flex flex-col gap-4 text-zinc-200 ${className}`}
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.7)]" />
          <span className="font-semibold text-xs tracking-wide text-zinc-100 uppercase">
            Time-Travel Trace Replay
          </span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
            {currentAgentLabel}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {forkSuccessNotice && (
            <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded animate-fade-in">
              {forkSuccessNotice}
            </span>
          )}

          <button
            type="button"
            data-testid="fork-run-btn"
            onClick={() => setForkModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[11px] font-medium transition-colors"
          >
            <GitFork size={13} />
            Fork Run
          </button>
        </div>
      </div>

      {/* Scrubbing Timeline Bar */}
      <div className="flex flex-col gap-1.5 bg-black/40 p-3 rounded-xl border border-white/[0.04]">
        <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
          <span className="flex items-center gap-1.5 text-zinc-300">
            <Clock size={12} className="text-cyan-400" />
            Step {currentStepIndex + 1} of {steps.length}
          </span>
          <span className="tabular-nums">
            {activeStep ? `${activeStep.durationMs}ms · ${activeStep.tokensUsed} tokens` : '0ms'}
          </span>
        </div>

        {/* Step dots & scrub line */}
        <div className="relative py-2 flex items-center">
          <input
            type="range"
            min={0}
            max={Math.max(0, steps.length - 1)}
            value={currentStepIndex}
            onChange={(e) => handleSeek(Number(e.target.value))}
            data-testid="trace-scrubber-slider"
            className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-white/10 rounded-lg appearance-none focus:outline-none"
          />
        </div>

        {/* Playback Controls & Speed Toggle */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleSeek(0)}
              disabled={currentStepIndex === 0}
              className="p-1.5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30 transition-colors"
              title="First step"
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              onClick={() => handleSeek(currentStepIndex - 1)}
              disabled={currentStepIndex === 0}
              className="p-1.5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30 transition-colors"
              title="Previous step"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              data-testid="trace-play-btn"
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-1.5 px-2 rounded-md bg-white/10 hover:bg-white/15 text-zinc-100 transition-colors flex items-center gap-1 text-[11px]"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSeek(currentStepIndex + 1)}
              disabled={currentStepIndex >= steps.length - 1}
              className="p-1.5 text-zinc-400 hover:text-zinc-100 disabled:opacity-30 transition-colors"
              title="Next step"
            >
              <ChevronRight size={15} />
            </button>
          </div>

          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-zinc-500 mr-1">Speed:</span>
            {[1, 2, 4].map((speed) => (
              <button
                key={speed}
                type="button"
                onClick={() => setPlaybackSpeed(speed)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  playbackSpeed === speed
                    ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/30'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {speed}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Trajectory Step Details & State Diffing */}
      {activeStep && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Left: Action & Execution Details */}
          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-black/30 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[9.5px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${getCategoryBadgeClass(
                  activeStep.category
                )}`}
              >
                {activeStep.category}
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {new Date(activeStep.timestamp).toLocaleTimeString()}
              </span>
            </div>

            <div className="text-xs font-mono font-medium text-zinc-100 break-all leading-relaxed">
              {activeStep.action}
            </div>

            {activeStep.outputPreview && (
              <div className="p-2.5 rounded-lg bg-[#0c0f17] border border-white/[0.04] text-[11px] font-mono text-zinc-300 leading-relaxed max-h-32 overflow-y-auto">
                <span className="text-zinc-500 block text-[9.5px] mb-1 uppercase font-sans font-semibold tracking-wider">
                  Output / Reasoning
                </span>
                {activeStep.outputPreview}
              </div>
            )}

            <div className="flex items-center gap-4 text-[10px] font-mono text-zinc-400 pt-1">
              <span className="flex items-center gap-1">
                <Cpu size={12} className="text-purple-400" />
                {activeStep.memoryMb} MB RSS
              </span>
              <span className="flex items-center gap-1">
                <Zap size={12} className="text-amber-400" />
                {activeStep.tokensUsed} tok
              </span>
              <span className="flex items-center gap-1">
                <Clock size={12} className="text-cyan-400" />
                {activeStep.durationMs}ms
              </span>
            </div>
          </div>

          {/* Right: State Delta & Diff Inspector */}
          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-black/30 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold tracking-wider uppercase text-zinc-400 flex items-center gap-1.5">
                <Layers size={12} className="text-cyan-400" />
                State Mutation Delta
              </span>
              <span className="text-[9.5px] font-mono text-zinc-500">
                {activeStep.stateDiff?.length || 0} modified
              </span>
            </div>

            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {activeStep.stateDiff && activeStep.stateDiff.length > 0 ? (
                activeStep.stateDiff.map((diff, i) => (
                  <div
                    key={i}
                    className="p-2 rounded-lg bg-[#0c0f17] border border-white/[0.04] text-[10.5px] font-mono flex flex-col gap-1"
                  >
                    <span className="text-zinc-400 font-semibold">{diff.key}</span>
                    <div className="flex items-center gap-2 text-zinc-300">
                      <span className="text-rose-400/80 bg-rose-500/10 px-1.5 py-0.5 rounded line-through">
                        {diff.before}
                      </span>
                      <ArrowRight size={10} className="text-zinc-500 shrink-0" />
                      <span className="text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-medium">
                        {diff.after}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-[10px] font-mono text-zinc-500 text-center py-6 border border-dashed border-white/[0.04] rounded-lg">
                  No state mutation registered in this step.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fork Trajectory Modal */}
      {forkModalOpen && (
        <div
          data-testid="fork-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fade-in"
        >
          <div className="w-full max-w-md bg-[#0b0e17] border border-white/[0.08] rounded-2xl p-5 shadow-2xl flex flex-col gap-3">
            <div className="flex items-center gap-2 text-cyan-300 font-semibold text-sm">
              <GitFork size={16} />
              Fork Mission Trajectory
            </div>
            <p className="text-xs text-zinc-400">
              Branch agent execution starting exactly at <strong>Step #{currentStepIndex + 1}</strong>. Provide an alternate directive or hypothesis to explore counterfactual runs.
            </p>

            <textarea
              data-testid="fork-prompt-input"
              value={forkPrompt}
              onChange={(e) => setForkPrompt(e.target.value)}
              placeholder="e.g. Try parallelizing the tool calls with speculative execution instead of sequential dispatch..."
              className="w-full h-24 p-2.5 rounded-xl bg-black/50 border border-white/[0.08] text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-400 transition-colors resize-none font-mono"
            />

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setForkModalOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-fork-btn"
                onClick={handleFork}
                className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs transition-colors shadow-[0_0_12px_rgba(0,245,255,0.3)]"
              >
                Confirm Fork
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
