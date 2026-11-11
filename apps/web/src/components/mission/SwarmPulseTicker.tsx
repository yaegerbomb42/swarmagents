'use client';

/**
 * SwarmPulseTicker — kinetic live-event marquee.
 * Streams the /api/v1/sse/logs event stream into an infinite,
 * GPU-friendly scrolling ribbon of swarm activity.
 */

import { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

type PulseEvent = {
  ts: number;
  kind: string;
  message: string;
};

const KIND_TONE: Record<string, string> = {
  task: 'text-cyan-300',
  lock: 'text-fuchsia-300',
  agent: 'text-emerald-300',
  error: 'text-rose-300',
};

export type SwarmPulseTickerProps = {
  maxEvents?: number;
  className?: string;
};

export default function SwarmPulseTicker({
  maxEvents = 24,
  className = '',
}: SwarmPulseTickerProps) {
  const [events, setEvents] = useState<PulseEvent[]>([]);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource(unifiedApi.sseLogsUrl());
    es.onopen = () => setLive(true);
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as PulseEvent;
        const key = `${evt.kind}:${evt.ts}:${evt.message}`;
        if (seenRef.current.has(key)) return;
        seenRef.current.add(key);
        if (seenRef.current.size > 400) seenRef.current = new Set();
        setEvents((prev) => [evt, ...prev].slice(0, maxEvents));
      } catch {
        /* malformed frame — skip */
      }
    };
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [maxEvents]);

  const ribbon = events.length > 0 ? events : [{ ts: 0, kind: 'idle', message: 'awaiting swarm activity…' }];

  return (
    <section
      data-testid="swarm-pulse-ticker"
      aria-label="Live swarm activity ticker"
      className={`relative overflow-hidden rounded-xl border border-white/10 bg-black/40 backdrop-blur-md ${className}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Zap
          className={`h-3 w-3 shrink-0 ${live ? 'text-cyan-300' : 'text-zinc-600'}`}
          aria-hidden
        />
        <span className="shrink-0 text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-500">
          {live ? 'swarm pulse' : 'reconnecting'}
        </span>
        <div className="relative flex-1 overflow-hidden">
          <div
            data-testid="ticker-ribbon"
            className="ticker-scroll flex items-center gap-6 whitespace-nowrap font-mono text-[10px]"
            style={{ animationPlayState: paused ? 'paused' : 'running' }}
          >
            {[0, 1].map((copy) => (
              <div key={copy} aria-hidden={copy === 1} className="flex items-center gap-6">
                {ribbon.map((evt, i) => (
                  <span key={`${copy}-${i}`} className="flex items-center gap-1.5">
                    <span className={KIND_TONE[evt.kind] ?? 'text-zinc-400'}>
                      [{evt.kind}]
                    </span>
                    <span className="text-zinc-400">{evt.message}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
