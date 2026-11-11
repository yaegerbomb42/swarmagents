'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, Zap } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type MissionEvent = {
  ts: number;
  kind: string;
  message: string;
  worker_id?: string;
  task_id?: string;
};

export type MissionTerminalFeedProps = {
  refreshIntervalMs?: number;
  className?: string;
};

function eventKey(ev: MissionEvent, index: number): string {
  return `${ev.kind}-${ev.ts}-${ev.message}-${index}`;
}

export default function MissionTerminalFeed({
  refreshIntervalMs = 6000,
  className = '',
}: MissionTerminalFeedProps) {
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await unifiedApi.missionEvents(30);
      setEvents(data.events ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'feed unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const url = unifiedApi.sseLogsUrl();
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setStreamLive(true);
      setError(null);
      setLoading(false);
    };

    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as MissionEvent;
        setEvents((prev) => {
          const next = [evt, ...prev];
          return next.slice(0, 80);
        });
      } catch {
        setError('malformed log stream');
      }
    };

    es.onerror = () => {
      setStreamLive(false);
      es.close();
      esRef.current = null;
      void load();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (streamLive) return;
    void load();
    const id = setInterval(() => void load(), refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs, streamLive]);

  return (
    <section
      data-testid="mission-terminal-feed"
      className={`flex flex-col rounded-xl border border-white/10 bg-[#06061a]/90 overflow-hidden min-h-[10rem] ${className}`}
      aria-label="Mission event feed"
    >
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2 shrink-0">
        <Radio className="h-3.5 w-3.5 text-amber-300" aria-hidden />
        <span className="text-[11px] font-medium text-white/85">Mission Feed</span>
        <span className="ml-auto text-[9px] font-mono text-zinc-500">
          {streamLive ? 'live sse' : 'polling'} · {events.length} events
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-[10px]">
        {loading ? <p className="text-zinc-500 px-1">Syncing fleet events…</p> : null}
        {error ? <p className="text-rose-300 px-1">{error}</p> : null}
        {!loading &&
          !error &&
          events.map((ev, i) => (
            <div
              key={eventKey(ev, i)}
              data-testid="mission-feed-line"
              className="flex gap-2 rounded px-1.5 py-1 hover:bg-white/[0.03]"
            >
              <Zap className="h-3 w-3 shrink-0 text-cyan-500/50 mt-0.5" aria-hidden />
              <span className="text-zinc-500 shrink-0">[{ev.kind}]</span>
              <span className="text-zinc-300 break-all">{ev.message}</span>
            </div>
          ))}
        {!loading && !error && events.length === 0 ? (
          <p className="text-zinc-600 px-1">No fleet events yet — workers will appear here live.</p>
        ) : null}
      </div>
    </section>
  );
}
