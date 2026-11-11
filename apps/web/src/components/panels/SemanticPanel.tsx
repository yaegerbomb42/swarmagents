'use client';

import { useCallback, useEffect, useState } from 'react';

export default function SemanticPanel() {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [goal, setGoal] = useState('Ship a reliable dashboard↔engine integration');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/semantic', { cache: 'no-store' });
      const data = await res.json();
      if (data.success === false && data.error) {
        setError(String(data.error));
        setState(null);
      } else {
        setError(null);
        setState((data.state as Record<string, unknown>) || data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const run = async (action: string) => {
    setBusy(true);
    setResult('');
    try {
      const res = await fetch('/api/semantic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, goal }),
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
      if (action === 'reset' || action === 'update' || action === 'probe') {
        await loadState();
      }
    } catch (e: unknown) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/90">Semantic / State Graph</h3>
        <button
          type="button"
          onClick={loadState}
          className="text-[10px] uppercase text-white/40 hover:text-white/70"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-amber-300/80 font-mono">{error}</p>}

      {state && (
        <pre className="text-[11px] font-mono text-white/60 p-3 rounded-lg bg-black/40 border border-white/[0.06] whitespace-pre-wrap max-h-36 overflow-auto">
          {JSON.stringify(state, null, 2)}
        </pre>
      )}

      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="w-full text-xs bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2 text-white outline-none"
        placeholder="Goal for probe / pollinate / state-graph"
      />

      <div className="flex flex-wrap gap-2">
        {(['probe', 'pollinate', 'state-graph', 'reset'] as const).map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy}
            onClick={() => run(a)}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 disabled:opacity-40"
          >
            {a}
          </button>
        ))}
      </div>

      {result && (
        <pre className="text-[11px] font-mono text-white/70 p-3 rounded-lg bg-black/40 border border-white/[0.06] whitespace-pre-wrap max-h-56 overflow-auto">
          {result}
        </pre>
      )}
    </div>
  );
}
