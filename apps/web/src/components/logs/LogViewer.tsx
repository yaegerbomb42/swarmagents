'use client';

import { useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type LogEntry = {
  ts: number;
  kind: string;
  message: string;
  worker_id?: string;
  task_id?: string;
};

export type LogViewerProps = {
  className?: string;
  maxLines?: number;
};

export default function LogViewer({ className = '', maxLines = 80 }: LogViewerProps) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const url = unifiedApi.sseLogsUrl();
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setLive(true);
      setError(null);
    };

    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as LogEntry;
        setLines((prev) => [...prev, evt].slice(-maxLines));
      } catch {
        setError('malformed log event');
      }
    };

    es.onerror = () => {
      setLive(false);
      setError('log stream disconnected');
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [maxLines]);

  useEffect(() => {
    tailRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <section
      data-testid="log-viewer"
      className={`rounded-lg border border-white/10 bg-black/40 flex flex-col min-h-0 ${className}`}
    >
      <header className="flex items-center gap-2 px-2 py-1.5 border-b border-white/5 shrink-0">
        <Radio className={`h-3 w-3 ${live ? 'text-emerald-400' : 'text-zinc-600'}`} />
        <span className="text-[10px] text-zinc-400">
          Execution logs {live ? <span className="text-emerald-400">· live</span> : null}
        </span>
        {error ? <span className="text-[10px] text-amber-400 ml-auto">{error}</span> : null}
      </header>
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[10px] leading-relaxed p-2">
        {lines.length === 0 ? (
          <p className="text-zinc-600">Waiting for SSE log events…</p>
        ) : (
          lines.map((line, i) => (
            <div key={`${line.ts}-${line.kind}-${i}`} className="text-zinc-500">
              <span className="text-zinc-600">[{line.kind}]</span> {line.message}
            </div>
          ))
        )}
        <div ref={tailRef} />
      </div>
    </section>
  );
}
