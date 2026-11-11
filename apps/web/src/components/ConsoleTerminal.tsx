'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, Trash2 } from 'lucide-react';

export type TerminalLine = {
  id: string;
  kind: 'input' | 'output' | 'error' | 'system';
  text: string;
};

export type ConsoleTerminalProps = {
  sessionId?: string;
  className?: string;
  /** Lines streamed in from mission telemetry (appended after mount). */
  feedLines?: TerminalLine[];
  /** Custom handler; return output text or null to use built-in commands */
  onCommand?: (cmd: string) => Promise<string | null> | string | null;
  initialLines?: TerminalLine[];
  /** Real connection state of the feed backing this terminal; defaults to unknown. */
  connection?: 'connected' | 'disconnected' | 'unknown';
};

const BUILTIN: Record<string, (sessionId?: string, connection?: string) => string> = {
  help: () =>
    [
      'SwarmAgents console — built-in commands:',
      '  help     — show this message',
      '  clear    — clear terminal',
      '  status   — fleet connection snapshot',
      '  whoami   — current session identity',
    ].join('\n'),
  status: (_sid, connection = 'unknown') => `feed: ${connection}`,
  whoami: (sid) => `session: ${sid ?? 'local-console'}`,
};

function uid(): string {
  return `ln_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function ConsoleTerminal({
  sessionId,
  className = '',
  feedLines = [],
  onCommand,
  initialLines = [],
  connection = 'unknown',
}: ConsoleTerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([
    { id: uid(), kind: 'system', text: 'SwarmAgents terminal ready. Type `help` for commands.' },
    ...initialLines,
  ]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [lines, busy]);

  useEffect(() => {
    if (!feedLines.length) return;
    setLines((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      const fresh = feedLines.filter((l) => !seen.has(l.id));
      if (!fresh.length) return prev;
      return [...prev, ...fresh].slice(-500);
    });
  }, [feedLines]);

  const append = useCallback((kind: TerminalLine['kind'], text: string) => {
    setLines((prev) => [...prev, { id: uid(), kind, text }]);
  }, []);

  const runCommand = useCallback(
    async (raw: string) => {
      const cmd = raw.trim();
      if (!cmd) return;
      append('input', `$ ${cmd}`);
      setHistory((h) => [...h, cmd]);
      setHistIdx(-1);
      setBusy(true);

      try {
        if (cmd === 'clear') {
          setLines([]);
          return;
        }

        const custom = onCommand ? await onCommand(cmd) : null;
        if (custom != null) {
          append(custom.startsWith('error:') ? 'error' : 'output', custom);
          return;
        }

        const [name, ...rest] = cmd.split(/\s+/);
        const fn = BUILTIN[name.toLowerCase()];
        if (fn) {
          append('output', fn(sessionId, connection) + (rest.length ? `\n(args ignored: ${rest.join(' ')})` : ''));
          return;
        }

        const res = await fetch('/api/console/terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd, sessionId }),
        });
        const data = (await res.json()) as { output?: string; error?: string };
        if (!res.ok || data.error) {
          append('error', data.error ?? `exit ${res.status}`);
        } else {
          append('output', data.output ?? '');
        }
      } catch (e) {
        append('error', e instanceof Error ? e.message : 'command failed');
      } finally {
        setBusy(false);
      }
    },
    [append, onCommand, sessionId, connection]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input;
      setInput('');
      void runCommand(v);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(history[next] ?? '');
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setInput('');
      } else {
        setHistIdx(next);
        setInput(history[next] ?? '');
      }
    }
  };

  return (
    <div
      className={`flex flex-col h-full min-h-0 rounded-xl border border-white/[0.06] overflow-hidden ${className}`}
      style={{
        background: 'rgba(6, 8, 12, 0.78)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
        <Terminal className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[11px] text-zinc-300 font-medium">Agent Console</span>
        {sessionId && <span className="text-[9px] text-zinc-600 font-mono truncate">{sessionId}</span>}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLines([]);
          }}
          className="ml-auto p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
          aria-label="Clear terminal"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-[11px] leading-5 space-y-0.5">
        {lines.map((line) => (
          <div
            key={line.id}
            className={
              line.kind === 'input'
                ? 'text-cyan-300/90'
                : line.kind === 'error'
                  ? 'text-rose-400'
                  : line.kind === 'system'
                    ? 'text-zinc-500'
                    : 'text-zinc-300 whitespace-pre-wrap'
            }
          >
            {line.text}
          </div>
        ))}
        {busy && <div className="text-zinc-500 animate-pulse">…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-white/[0.06] bg-black/20">
        <span className="text-cyan-400/80 select-none">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          className="flex-1 bg-transparent outline-none text-zinc-100 placeholder:text-zinc-600 text-[11px] font-mono"
          placeholder="Enter command…"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
