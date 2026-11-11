'use client';

import React, { useState } from 'react';
import { CheckCircle2, Circle, Loader2, ShieldAlert } from 'lucide-react';
import HumanCheckpointGateModal from './HumanCheckpointGateModal';

export type CheckpointPhase = {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete';
  workers?: number;
  requiresApproval?: boolean;
};

export type MissionCheckpointBarProps = {
  phases: CheckpointPhase[];
  className?: string;
  onSelectPhase?: (phase: CheckpointPhase) => void;
};

function PhaseIcon({ status }: { status: CheckpointPhase['status'] }) {
  if (status === 'complete') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === 'active') return <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin" />;
  return <Circle className="h-3.5 w-3.5 text-zinc-600" />;
}

export default function MissionCheckpointBar({ phases, className = '', onSelectPhase }: MissionCheckpointBarProps) {
  const [gateOpen, setGateOpen] = useState(false);
  const [activePhase, setActivePhase] = useState<CheckpointPhase | null>(null);

  const handleClick = (phase: CheckpointPhase) => {
    setActivePhase(phase);
    setGateOpen(true);
    if (onSelectPhase) onSelectPhase(phase);
  };

  return (
    <>
      <div
        data-testid="mission-checkpoint-bar"
        className={`flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-[#06061a]/80 px-3 py-2 ${className}`}
        role="list"
        aria-label="Mission checkpoint pipeline"
      >
        {phases.map((phase, i) => (
          <div key={phase.id} className="flex items-center gap-2" role="listitem">
            <button
              type="button"
              onClick={() => handleClick(phase)}
              data-testid={`checkpoint-${phase.id}`}
              data-status={phase.status}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-mono uppercase tracking-wide cursor-pointer transition hover:opacity-85 ${
                phase.status === 'complete'
                  ? 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/20'
                  : phase.status === 'active'
                    ? 'bg-cyan-500/10 text-cyan-200 border border-cyan-500/25'
                    : 'bg-white/[0.02] text-zinc-500 border border-white/5'
              }`}
            >
              <PhaseIcon status={phase.status} />
              <span>{phase.label}</span>
              {phase.status === 'active' && typeof phase.workers === 'number' && phase.workers > 0 ? (
                <span className="text-[9px] text-cyan-300/60">{phase.workers}w</span>
              ) : null}
            </button>
            {i < phases.length - 1 ? (
              <span className="text-zinc-700 text-xs" aria-hidden>
                →
              </span>
            ) : null}
          </div>
        ))}

        <button
          type="button"
          onClick={() => setGateOpen(true)}
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-[10px] font-mono transition"
          title="Review Checkpoint Approvals"
        >
          <ShieldAlert size={12} />
          <span>Review Gate</span>
        </button>
      </div>

      <HumanCheckpointGateModal
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        checkpointTitle={activePhase ? `Review Checkpoint: ${activePhase.label}` : 'Mission Gate Approvals'}
        onApprove={(ids) => {
          if (typeof window !== 'undefined') {
            const event = new CustomEvent('checkpoint-gate-approved', { detail: { ids } });
            window.dispatchEvent(event);
          }
        }}
        onReject={(ids, reason) => {
          if (typeof window !== 'undefined') {
            const event = new CustomEvent('checkpoint-gate-rejected', { detail: { ids, reason } });
            window.dispatchEvent(event);
          }
        }}
      />
    </>
  );
}
