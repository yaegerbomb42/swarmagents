'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useHarnessTask, type HarnessEvent } from '@/hooks/useHarnessTask';

const PROVIDERS = [
  { id: 'auto', label: 'Auto' },
  { id: 'mercury', label: 'Mercury 3' },
  { id: 'nemotron', label: 'Nemotron Ultra' },
  { id: 'race', label: 'Race both' },
] as const;

type ClusterInfo = { name: string; label: string; model: string; keys: number };
type HarnessInfo = { status: string; engine: string; clusters: ClusterInfo[]; authRequired: boolean };

const TOKEN_KEY = 'swarm.harnessToken';

function describe(e: HarnessEvent): { tag: string; text: string; tone: 'dim' | 'ok' | 'warn' | 'err' | 'info' } {
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  switch (e.type) {
    case 'task.accepted':
      return { tag: 'accepted', text: `${s(e.title)} · ${s(e.provider)}`, tone: 'info' };
    case 'task.started': {
      const cl = Array.isArray(e.clusters) ? (e.clusters as ClusterInfo[]) : [];
      return { tag: 'engine', text: `Omnexx loop started · ${cl.map((c) => `${c.name} (${c.keys} keys)`).join(' → ')} · ${s(e.mode)}`, tone: 'info' };
    }
    case 'step.model': {
      const t = (e.tokens ?? {}) as Record<string, number>;
      const inTok = (t.uncached ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
      return { tag: `turn ${s(e.turn)}`, text: `${s(e.model)} · ${s(e.ms)}ms · ${inTok} in / ${t.output ?? 0} out · ${s(e.stopReason)}`, tone: 'dim' };
    }
    case 'step.thinking':
      return { tag: 'thinking', text: s(e.text), tone: 'dim' };
    case 'step.tool.start':
      return { tag: s(e.tool), text: s(e.doing) || 'running', tone: 'info' };
    case 'step.tool.done':
      return e.isError
        ? { tag: s(e.tool), text: `failed: ${s(e.error).slice(0, 200)}`, tone: 'err' }
        : { tag: s(e.tool), text: `done · ${s(e.bytes)} bytes`, tone: 'ok' };
    case 'cluster.race.win':
      return { tag: 'race', text: `${s(e.cluster)} key #${s(e.key)} won in ${s(e.ms)}ms`, tone: 'dim' };
    case 'cluster.race.rejected':
      return { tag: 'race', text: `${s(e.cluster)} key #${s(e.key)} returned an unusable answer, racing on`, tone: 'warn' };
    case 'cluster.key.cooldown':
      return { tag: 'rotate', text: `${s(e.cluster)} key #${s(e.key)} cooling ${Math.round(Number(e.ms) / 1000)}s (HTTP ${s(e.status) || '—'})`, tone: 'warn' };
    case 'cluster.key.benched':
      return { tag: 'rotate', text: `${s(e.cluster)} key #${s(e.key)} benched (HTTP ${s(e.status)})`, tone: 'warn' };
    case 'task.done':
      return { tag: 'done', text: `${s(e.status)} · ${s(e.turns)} turns · ${Math.round(Number(e.durationMs) / 100) / 10}s`, tone: e.status === 'completed' ? 'ok' : 'err' };
    case 'task.error':
      return { tag: 'error', text: s(e.message), tone: 'err' };
    default:
      return { tag: e.type.replace(/^engine\./, ''), text: Object.entries(e).filter(([k]) => !['seq', 'ts', 'taskId', 'type'].includes(k)).map(([k, v]) => `${k}=${s(v).slice(0, 80)}`).join(' '), tone: 'dim' };
  }
}

const TONE: Record<string, string> = {
  dim: 'text-zinc-500',
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  err: 'text-rose-400',
  info: 'text-sky-300',
};

export default function OmnexxConsole() {
  const { events, status, taskId, finalText, files, error, dispatch, cancel, reset } = useHarnessTask();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<string>('auto');
  const [info, setInfo] = useState<HarnessInfo | null>(null);
  const [token, setToken] = useState('');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? '');
    } catch {}
    fetch('/api/harness/task', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: HarnessInfo) => setInfo(j))
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events.length]);

  const stats = useMemo(() => {
    let turns = 0, tokensOut = 0, tools = 0, ms = 0;
    for (const e of events) {
      if (e.type === 'step.model') {
        turns++;
        ms += Number(e.ms) || 0;
        tokensOut += Number((e.tokens as Record<string, number> | undefined)?.output) || 0;
      }
      if (e.type === 'step.tool.done') tools++;
    }
    return { turns, tokensOut, tools, avgMs: turns ? Math.round(ms / turns) : 0 };
  }, [events]);

  const running = status === 'running';
  const submit = () => {
    const p = prompt.trim();
    if (!p || running) return;
    setOpenFile(null);
    void dispatch({ prompt: p, cluster: provider, ...(token ? { token } : {}) });
  };

  return (
    <div className="min-h-[100svh] bg-[#050508] text-zinc-100 font-sans">
      <div className="mx-auto max-w-4xl px-4 py-10 md:py-16">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">SwarmAgents · Omnexx console</h1>
            <p className="text-xs text-zinc-500">Give a goal. The Omnexx engine plans, writes files and verifies, live.</p>
          </div>
          <div className="text-right text-[11px] font-mono text-zinc-500" data-testid="engine-status">
            {info ? (
              <>
                <span className={info.status === 'online' ? 'text-emerald-400' : 'text-amber-400'}>● {info.status}</span>
                <div>{info.clusters.map((c) => `${c.name}:${c.keys}`).join('  ')}</div>
              </>
            ) : (
              'checking engine…'
            )}
          </div>
        </header>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 shadow-[0_0_40px_rgba(56,189,248,0.06)] focus-within:border-zinc-600">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="e.g. Write a TypeScript function that validates email addresses, with tests and a README"
            rows={3}
            className="w-full resize-none bg-transparent px-2 py-1 text-[15px] outline-none placeholder:text-zinc-600"
            data-testid="console-prompt"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProvider(p.id)}
                className={`rounded-full border px-3 py-1 text-xs transition ${provider === p.id ? 'border-sky-400/60 bg-sky-400/10 text-sky-200' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'}`}
              >
                {p.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {info?.authRequired && (
                <input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    try {
                      localStorage.setItem(TOKEN_KEY, e.target.value);
                    } catch {}
                  }}
                  placeholder="access token"
                  className="w-32 rounded-md border border-zinc-800 bg-transparent px-2 py-1 text-xs outline-none"
                />
              )}
              {running ? (
                <button type="button" onClick={cancel} className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700">
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!prompt.trim()}
                  className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
                  data-testid="console-run"
                >
                  Run ⌘↵
                </button>
              )}
            </div>
          </div>
        </div>

        {(events.length > 0 || error) && (
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60">
            <div className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 font-mono text-[11px] text-zinc-500">
              <span className={running ? 'text-sky-300' : status === 'completed' ? 'text-emerald-400' : 'text-rose-400'} data-testid="console-status">
                {running ? '● running' : status}
              </span>
              <span>{taskId}</span>
              <span>turns {stats.turns}</span>
              <span>tools {stats.tools}</span>
              <span>out {stats.tokensOut} tok</span>
              <span>avg {stats.avgMs}ms/turn</span>
              {status !== 'running' && (
                <button type="button" onClick={reset} className="ml-auto hover:text-zinc-300">
                  clear
                </button>
              )}
            </div>
            <div ref={feedRef} className="max-h-[45vh] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed" data-testid="console-feed">
              {events.map((e) => {
                const d = describe(e);
                return (
                  <div key={`${e.seq}-${e.ts}-${e.type}`} className="flex gap-3">
                    <span className="w-16 shrink-0 text-zinc-600">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`w-20 shrink-0 truncate ${TONE[d.tone]}`}>{d.tag}</span>
                    <span className="min-w-0 break-words text-zinc-300">{d.text}</span>
                  </div>
                );
              })}
              {error && <div className="mt-2 text-rose-400">{error}</div>}
            </div>
          </section>
        )}

        {finalText && (
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4" data-testid="console-result">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">Result</div>
            <div className="whitespace-pre-wrap text-sm text-zinc-200">{finalText}</div>
          </section>
        )}

        {files.length > 0 && (
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">Files ({files.length})</div>
            <div className="flex flex-wrap gap-2">
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setOpenFile(openFile === f.path ? null : f.path)}
                  className={`rounded-md border px-2 py-1 font-mono text-xs ${openFile === f.path ? 'border-sky-400/60 text-sky-200' : 'border-zinc-800 text-zinc-400'}`}
                >
                  {f.path}
                </button>
              ))}
            </div>
            {openFile && (
              <pre className="mt-3 max-h-[50vh] overflow-auto rounded-lg bg-black/60 p-3 font-mono text-[12px] text-zinc-300">
                {files.find((f) => f.path === openFile)?.content}
              </pre>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
