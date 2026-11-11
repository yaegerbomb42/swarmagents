'use client';

import { useCallback, useEffect, useState } from 'react';

export default function ToolsDetail() {
  const [tools, setTools] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [command, setCommand] = useState('git status --short');
  const [output, setOutput] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [gitStatus, setGitStatus] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tools', { cache: 'no-store' });
      const data = await res.json();
      const list = Array.isArray(data.tools)
        ? data.tools.map((t: unknown) => (typeof t === 'string' ? t : JSON.stringify(t)))
        : [];
      setTools(list);
      setNote(data.note ? String(data.note) : null);
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runShell = async () => {
    if (!command.trim() || busy) return;
    setBusy(true);
    setOutput('');
    try {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'shell', command: command.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setOutput(String(data.error));
      } else {
        setOutput(
          [`$ ${command}`, data.stdout || '', data.stderr ? `stderr:\n${data.stderr}` : '']
            .filter(Boolean)
            .join('\n'),
        );
      }
    } catch (e: unknown) {
      setOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshGit = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'git_status' }),
      });
      const data = await res.json();
      setGitStatus(data.status || data.error || JSON.stringify(data));
    } catch (e: unknown) {
      setGitStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-black/20 rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <span className="text-sm">🔧</span>
        <span className="text-sm font-medium text-white/80">Tools</span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div>
          <div className="text-[10px] uppercase text-white/40 mb-2">Registry</div>
          {note && <p className="text-xs text-amber-300/80 mb-2 font-mono">{note}</p>}
          <div className="flex flex-wrap gap-1.5">
            {tools.length === 0 && (
              <span className="text-xs text-white/40">No tools reported by engine</span>
            )}
            {tools.map((t) => (
              <span
                key={t}
                className="text-[10px] font-mono px-2 py-1 rounded bg-white/[0.04] border border-white/[0.06] text-white/70"
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase text-white/40">Shell via engine</div>
          <div className="flex gap-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runShell()}
              className="flex-1 text-xs font-mono bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2 text-white outline-none"
            />
            <button
              type="button"
              onClick={runShell}
              disabled={busy}
              className="px-3 py-2 text-xs rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 disabled:opacity-40"
            >
              Run
            </button>
            <button
              type="button"
              onClick={refreshGit}
              disabled={busy}
              className="px-3 py-2 text-xs rounded-lg bg-white/[0.04] text-white/60 border border-white/[0.08]"
            >
              Git
            </button>
          </div>
          {(output || gitStatus) && (
            <pre className="text-[11px] font-mono text-white/70 whitespace-pre-wrap max-h-56 overflow-auto p-3 rounded-lg bg-black/40 border border-white/[0.06]">
              {output || gitStatus}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
