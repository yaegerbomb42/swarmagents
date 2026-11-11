'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gavel, Play, Pause, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type ConsensusTurn = {
  role: string;
  agent_id: string;
  content: string;
};

export type ConsensusPayload = {
  accepted: boolean;
  final_proposal: string;
  critiques?: Array<{ agent_id: string; score: number; accepted: boolean; suggestion?: string }>;
  transcript: ConsensusTurn[];
  rounds: number;
  test_output?: string;
};

export type ConsensusReplayProps = {
  consensus?: ConsensusPayload | null;
  autoFetch?: boolean;
  className?: string;
};

function roleBadgeClass(role: string): string {
  if (role === 'proposer') return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200';
  if (role === 'critic') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  if (role === 'judge') return 'border-purple-500/30 bg-purple-500/10 text-purple-200';
  return 'border-white/10 bg-white/5 text-white/60';
}

export default function ConsensusReplay({
  consensus: consensusProp,
  autoFetch = true,
  className = '',
}: ConsensusReplayProps) {
  const [consensus, setConsensus] = useState<ConsensusPayload | null>(consensusProp ?? null);
  const [loading, setLoading] = useState(autoFetch && !consensusProp);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await unifiedApi.groupchatConsensus();
      const payload = data.consensus as ConsensusPayload;
      setConsensus(payload);
      setStep(0);
      setPlaying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load consensus');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (consensusProp) {
      setConsensus(consensusProp);
      setStep(0);
      setPlaying(false);
      return;
    }
    if (autoFetch) void load();
  }, [autoFetch, consensusProp, load]);

  const transcript = consensus?.transcript ?? [];
  const maxStep = Math.max(0, transcript.length - 1);
  const visible = useMemo(() => transcript.slice(0, step + 1), [transcript, step]);

  useEffect(() => {
    if (!playing || visible.length >= transcript.length) {
      if (playing && visible.length >= transcript.length) setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setStep((s) => Math.min(s + 1, maxStep)), 900);
    return () => window.clearTimeout(id);
  }, [playing, visible.length, transcript.length, maxStep]);

  const reset = () => {
    setStep(0);
    setPlaying(false);
  };

  return (
    <section
      data-testid="consensus-replay"
      className={`flex flex-col rounded-xl border border-white/10 bg-[#06061a]/90 backdrop-blur-md overflow-hidden ${className}`}
      aria-label="Consensus deliberation replay"
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Gavel className="h-4 w-4 text-purple-300 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/90 truncate">Consensus Replay</p>
            <p className="text-[10px] text-zinc-500">
              {consensus
                ? `${consensus.rounds} round(s) · ${consensus.accepted ? 'accepted' : 'rejected'}`
                : '3-tier proposer → critic → judge'}
            </p>
          </div>
        </div>
        {autoFetch && !consensusProp ? (
          <button
            type="button"
            onClick={() => void load()}
            className="text-[10px] font-mono text-cyan-300/80 hover:text-cyan-200"
          >
            Refresh
          </button>
        ) : null}
      </header>

      {loading ? (
        <div className="p-4 text-xs text-zinc-500">Loading deliberation…</div>
      ) : error ? (
        <div className="p-4 text-xs text-rose-300">{error}</div>
      ) : !consensus ? (
        <div className="p-4 text-xs text-zinc-500">No consensus data</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
            <button type="button" onClick={reset} className="tactile-icon p-1.5" aria-label="Reset replay">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step <= 0}
              className="tactile-icon p-1.5 disabled:opacity-30"
              aria-label="Previous turn"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={transcript.length === 0}
              className="tactile-icon p-1.5 disabled:opacity-30"
              aria-label={playing ? 'Pause replay' : 'Play replay'}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(maxStep, s + 1))}
              disabled={step >= maxStep}
              className="tactile-icon p-1.5 disabled:opacity-30"
              aria-label="Next turn"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={0}
              max={maxStep}
              value={step}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              className="flex-1 min-w-[6rem] accent-cyan-400"
              aria-label="Replay scrubber"
            />
            <span className="text-[10px] font-mono text-white/35 tabular-nums">
              {step + 1}/{transcript.length || 1}
            </span>
          </div>

          <div className="flex-1 min-h-[10rem] max-h-72 overflow-y-auto p-3 space-y-2">
            {visible.map((turn, i) => (
              <article
                key={`${turn.role}-${turn.agent_id}-${i}`}
                data-testid={`consensus-turn-${i}`}
                className={`rounded-lg border px-2.5 py-2 ${
                  i === step ? 'border-cyan-500/25 bg-cyan-500/5' : 'border-white/5 bg-white/[0.02]'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${roleBadgeClass(turn.role)}`}>
                    {turn.role}
                  </span>
                  <span className="text-[9px] font-mono text-white/30">{turn.agent_id}</span>
                </div>
                <p className="text-[11px] text-white/75 whitespace-pre-wrap">{turn.content}</p>
              </article>
            ))}
          </div>

          {consensus.final_proposal ? (
            <footer className="border-t border-white/5 px-3 py-2 text-[10px] text-zinc-500">
              <span className="text-white/40">Final: </span>
              <span className={consensus.accepted ? 'text-emerald-300' : 'text-rose-300'}>
                {consensus.final_proposal}
              </span>
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}
