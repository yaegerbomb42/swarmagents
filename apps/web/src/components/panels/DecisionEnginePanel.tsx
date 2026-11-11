'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Brain, Zap, CheckCircle, AlertCircle, RotateCcw, Send, Loader2 } from 'lucide-react';

interface EngineStatus {
  provider: string;
  model: string;
  mode: string;
  active: boolean;
  total_calls: number;
  success_rate: number;
  avg_latency_ms: number;
  last_error: string | null;
  fallback_rate: number;
}

export default function DecisionEnginePanel() {
  const [status, setStatus] = useState<EngineStatus>({
    provider: 'engine',
    model: 'routing',
    mode: 'idle',
    active: false,
    total_calls: 0,
    success_rate: 0,
    avg_latency_ms: 0,
    last_error: null,
    fallback_rate: 0,
  });
  const [loading, setLoading] = useState(true);
  const [testPrompt, setTestPrompt] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [mode, setMode] = useState<'chat' | 'decide'>('chat');

  const refreshStatus = useCallback(async () => {
    try {
      const [healthRes, hamRes] = await Promise.all([
        fetch('/api/engine/health', { cache: 'no-store' }).catch(() => null),
        fetch('/api/hamiltonian', { cache: 'no-store' }).catch(() => null),
      ]);

      let active = false;
      let model = 'routing';
      let provider = 'engine';
      let last_error: string | null = null;
      let total_calls = 0;
      let avg_latency_ms = 0;
      let fallback_rate = 0;

      if (healthRes?.ok) {
        const h = await healthRes.json();
        active = h.status === 'healthy' || h.ok === true || !!h.uptime;
        provider = h.provider || 'engine';
      } else {
        last_error = 'Engine health unreachable';
      }

      if (hamRes?.ok) {
        const ham = await hamRes.json();
        model = ham.provider || ham.model || model;
        total_calls = ham.total_calls ?? ham.metrics?.total_calls ?? 0;
        avg_latency_ms = ham.avg_latency_ms ?? ham.metrics?.avg_latency_ms ?? 0;
        fallback_rate = ham.fallback_rate ?? 0;
        if (ham.active !== undefined) active = !!ham.active || active;
      }

      setStatus((prev) => ({
        ...prev,
        active,
        mode: active ? 'connected' : 'offline',
        model,
        provider,
        last_error,
        total_calls: total_calls || prev.total_calls,
        avg_latency_ms: avg_latency_ms || prev.avg_latency_ms,
        fallback_rate,
      }));
    } catch {
      setStatus((prev) => ({
        ...prev,
        active: false,
        mode: 'offline',
        last_error: 'Network unreachable',
      }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 15_000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const runTest = useCallback(async () => {
    if (!testPrompt.trim() || testing) return;
    setTesting(true);
    setTestResult(null);
    const start = Date.now();
    try {
      if (mode === 'decide') {
        const res = await fetch('/api/hamiltonian/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_state: 'dashboard_operator_idle',
            goal_state: testPrompt.trim(),
            available_actions: [
              'decompose_task',
              'spawn_agents',
              'query_memory',
              'run_browser',
              'respond_directly',
            ],
            momentum: ['user_request', 'cost_aware', 'precision_first'],
          }),
        });
        const data = await res.json();
        const latency = Date.now() - start;
        if (data.success || data.optimal_action) {
          setTestResult(
            `Action: ${data.optimal_action ?? '—'}\nRationale: ${data.rationale ?? JSON.stringify(data, null, 2)}`,
          );
          setStatus((prev) => ({
            ...prev,
            total_calls: prev.total_calls + 1,
            avg_latency_ms: Math.round(
              (prev.avg_latency_ms * prev.total_calls + latency) / (prev.total_calls + 1),
            ),
            success_rate: (prev.success_rate * prev.total_calls + 1) / (prev.total_calls + 1),
            active: true,
            mode: 'connected',
          }));
        } else {
          setTestResult(`Error: ${data.error || 'decide_failed'}`);
        }
      } else {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: testPrompt,
            model_preference: 'ceo_brain',
          }),
        });
        const data = await res.json();
        const latency = Date.now() - start;
        if (data.success && data.response) {
          setTestResult(data.response);
          setStatus((prev) => ({
            ...prev,
            provider: 'engine',
            model: data.model_used || prev.model,
            total_calls: prev.total_calls + 1,
            avg_latency_ms: Math.round(
              (prev.avg_latency_ms * prev.total_calls + latency) / (prev.total_calls + 1),
            ),
            success_rate: (prev.success_rate * prev.total_calls + 1) / (prev.total_calls + 1),
            active: true,
            mode: 'connected',
          }));
        } else {
          setTestResult(`Error: ${data.error || 'Unknown failure'}`);
        }
      }
    } catch (e: unknown) {
      setTestResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  }, [testPrompt, testing, mode]);

  const resetMetrics = async () => {
    try {
      await fetch('/api/hamiltonian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      });
      setStatus((prev) => ({
        ...prev,
        total_calls: 0,
        success_rate: 0,
        avg_latency_ms: 0,
        fallback_rate: 0,
      }));
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return (
      <div className="p-4 animate-pulse space-y-3">
        <div className="h-4 bg-white/10 rounded w-1/3" />
        <div className="h-16 bg-white/5 rounded" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white/90">Decision Engine</h3>
        </div>
        <div className="flex items-center gap-2">
          {status.active ? (
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
          )}
          <span className="text-[10px] uppercase tracking-wide text-white/50">{status.mode}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="p-2 rounded bg-white/[0.03] border border-white/[0.06]">
          <div className="text-white/40">Provider</div>
          <div className="text-white/80 truncate">{status.provider}</div>
        </div>
        <div className="p-2 rounded bg-white/[0.03] border border-white/[0.06]">
          <div className="text-white/40">Model</div>
          <div className="text-white/80 truncate">{status.model}</div>
        </div>
        <div className="p-2 rounded bg-white/[0.03] border border-white/[0.06]">
          <div className="text-white/40">Calls</div>
          <div className="text-white/80">{status.total_calls}</div>
        </div>
        <div className="p-2 rounded bg-white/[0.03] border border-white/[0.06]">
          <div className="text-white/40">Avg latency</div>
          <div className="text-white/80">{status.avg_latency_ms}ms</div>
        </div>
      </div>

      {status.last_error && (
        <p className="text-[11px] text-rose-300/80 font-mono">{status.last_error}</p>
      )}

      <div className="flex gap-1 p-0.5 rounded-lg bg-black/40 border border-white/[0.06]">
        {(['chat', 'decide'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 text-[11px] py-1.5 rounded-md transition ${
              mode === m ? 'bg-cyan-500/20 text-cyan-300' : 'text-white/40 hover:text-white/70'
            }`}
          >
            {m === 'chat' ? 'Engine /chat' : 'Hamiltonian /decide'}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={testPrompt}
          onChange={(e) => setTestPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runTest()}
          placeholder={mode === 'decide' ? 'Goal state…' : 'Test prompt…'}
          className="flex-1 text-xs bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2 text-white placeholder-white/30 outline-none focus:border-cyan-500/40"
        />
        <button
          type="button"
          onClick={runTest}
          disabled={testing || !testPrompt.trim()}
          className="px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 disabled:opacity-40"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={resetMetrics}
          className="px-2 py-2 rounded-lg bg-white/[0.04] text-white/50 border border-white/[0.06] hover:text-white/80"
          title="Reset metrics"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {testResult && (
        <pre className="text-[11px] font-mono text-white/70 whitespace-pre-wrap max-h-48 overflow-auto p-3 rounded-lg bg-black/40 border border-white/[0.06]">
          {testResult}
        </pre>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-white/30">
        <Zap className="w-3 h-3" />
        Routed through unified engine (:8400)
      </div>
    </div>
  );
}
