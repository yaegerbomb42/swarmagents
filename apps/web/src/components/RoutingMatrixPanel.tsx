'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Settings,
  RefreshCw,
  Save,
  RotateCcw,
  Plus,
  X,
  Zap,
  DollarSign,
  Gauge,
  Users,
} from 'lucide-react';
import RouterProbabilityPanel from '@/components/quantum/RouterProbabilityPanel';
import { AGENT_ROLES } from '@/lib/agentRoles';
import {
  type AgentRole,
  type RoleRoute,
  type RouteUsage,
  type RoutingMatrix,
  defaultRoute,
  MODEL_SUGGESTIONS,
  PROVIDER_OPTIONS,
  usagePct,
} from '@/lib/routingMatrix';

function UsageBar({
  label,
  pct,
  detail,
  warn,
}: {
  label: string;
  pct: number;
  detail: string;
  warn?: boolean;
}) {
  const color =
    pct >= 90 ? 'bg-rose-400' : pct >= 70 ? 'bg-amber-400' : warn ? 'bg-amber-400' : 'bg-cyan-400';
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[8px] font-mono text-white/35">
        <span>{label}</span>
        <span className={pct >= 90 ? 'text-rose-300' : ''}>{detail}</span>
      </div>
      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-150 ${color}`}
          style={{
            width: `${Math.max(2, Math.min(100, pct))}%`,
            boxShadow: pct > 15 ? '0 0 8px currentColor' : undefined,
          }}
        />
      </div>
    </div>
  );
}

function RouteRow({
  route,
  usage,
  onChange,
}: {
  route: RoleRoute;
  usage?: { callsToday: number; tokensToday: number; spendUsd: number; rpmWindow: number };
  onChange: (next: RoleRoute) => void;
}) {
  const models = MODEL_SUGGESTIONS[route.provider] || [];
  const [fallbackDraft, setFallbackDraft] = useState('');
  const rpmPct = usagePct(usage?.rpmWindow || 0, route.rpmLimit);
  const budgetPct = usagePct(usage?.spendUsd || 0, route.dailyBudgetUsd);

  return (
    <div
      className={`tactile-panel rounded-lg border p-3 space-y-3 transition-opacity ${
        route.enabled
          ? 'border-cyan-500/15'
          : 'border-white/5 opacity-60'
      }`}
      style={{
        background: 'rgba(8, 10, 18, 0.55)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-cyan-200">{route.label}</span>
            <span className="text-[8px] font-mono uppercase text-white/25">{route.role}</span>
          </div>
          <p className="text-[10px] text-white/35 mt-0.5">{route.description}</p>
        </div>
        <label className="flex items-center gap-1.5 text-[9px] font-mono text-white/40 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={route.enabled}
            onChange={(e) => onChange({ ...route, enabled: e.target.checked })}
            className="accent-cyan-400"
          />
          on
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-[8px] font-mono uppercase text-white/30 block mb-1">Provider</label>
          <select
            value={route.provider}
            onChange={(e) => {
              const provider = e.target.value;
              const suggestions = MODEL_SUGGESTIONS[provider] || [];
              onChange({
                ...route,
                provider,
                model: suggestions.includes(route.model)
                  ? route.model
                  : suggestions[0] || route.model,
              });
            }}
            className="tactile-field w-full bg-[#07070f] border border-cyan-500/15 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[8px] font-mono uppercase text-white/30 block mb-1">Model</label>
          <input
            list={`models-${route.role}`}
            value={route.model}
            onChange={(e) => onChange({ ...route, model: e.target.value })}
            className="tactile-field w-full bg-[#07070f] border border-cyan-500/15 rounded px-2 py-1.5 text-xs text-slate-200 font-mono focus:outline-none"
          />
          <datalist id={`models-${route.role}`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[8px] font-mono uppercase text-white/30 flex items-center gap-1 mb-1">
            <Gauge size={9} /> RPM
          </label>
          <input
            type="number"
            min={1}
            value={route.rpmLimit}
            onChange={(e) => onChange({ ...route, rpmLimit: Number(e.target.value) || 1 })}
            className="tactile-field w-full bg-[#07070f] border border-cyan-500/15 rounded px-2 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[8px] font-mono uppercase text-white/30 flex items-center gap-1 mb-1">
            <DollarSign size={9} /> $/day
          </label>
          <input
            type="number"
            min={0}
            step={0.5}
            value={route.dailyBudgetUsd}
            onChange={(e) =>
              onChange({ ...route, dailyBudgetUsd: Number(e.target.value) || 0 })
            }
            className="tactile-field w-full bg-[#07070f] border border-cyan-500/15 rounded px-2 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[8px] font-mono uppercase text-white/30 flex items-center gap-1 mb-1">
            <Users size={9} /> Max ∥
          </label>
          <input
            type="number"
            min={1}
            value={route.maxConcurrent}
            onChange={(e) =>
              onChange({ ...route, maxConcurrent: Number(e.target.value) || 1 })
            }
            className="tactile-field w-full bg-[#07070f] border border-cyan-500/15 rounded px-2 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none"
          />
        </div>
      </div>

      {/* Fallbacks */}
      <div>
        <label className="text-[8px] font-mono uppercase text-white/30 block mb-1">
          Fallback chain
        </label>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {route.fallbacks.map((fb, i) => (
            <span
              key={`${fb}-${i}`}
              className="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border border-white/10 text-white/50 transition-colors hover:border-cyan-500/25 hover:text-white/70"
            >
              {fb}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...route,
                    fallbacks: route.fallbacks.filter((_, j) => j !== i),
                  })
                }
                className="tactile-icon p-0.5 text-white/30 hover:text-rose-300"
              >
                <X size={9} />
              </button>
            </span>
          ))}
          {!route.fallbacks.length && (
            <span className="text-[9px] text-white/20">none</span>
          )}
        </div>
        <div className="flex gap-1">
          <input
            value={fallbackDraft}
            onChange={(e) => setFallbackDraft(e.target.value)}
            placeholder="provider:model"
            className="tactile-field flex-1 bg-[#07070f] border border-cyan-500/10 rounded px-2 py-1 text-[10px] font-mono text-white/60 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fallbackDraft.trim()) {
                onChange({
                  ...route,
                  fallbacks: [...route.fallbacks, fallbackDraft.trim()].slice(0, 5),
                });
                setFallbackDraft('');
              }
            }}
          />
          <button
            type="button"
            disabled={!fallbackDraft.trim()}
            onClick={() => {
              onChange({
                ...route,
                fallbacks: [...route.fallbacks, fallbackDraft.trim()].slice(0, 5),
              });
              setFallbackDraft('');
            }}
            className="tactile-ghost px-2 py-1 text-cyan-400/70"
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      {/* Live usage */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/5">
        <UsageBar
          label="RPM window"
          pct={rpmPct}
          detail={`${usage?.rpmWindow || 0}/${route.rpmLimit}`}
          warn={rpmPct >= 70}
        />
        <UsageBar
          label="Daily $"
          pct={budgetPct}
          detail={`$${(usage?.spendUsd || 0).toFixed(2)}/$${route.dailyBudgetUsd}`}
          warn={budgetPct >= 70}
        />
      </div>
      <div className="text-[8px] font-mono text-white/25 flex gap-3">
        <span>{usage?.callsToday || 0} calls today</span>
        <span>{(usage?.tokensToday || 0).toLocaleString()} tok</span>
      </div>
    </div>
  );
}

interface ProviderMetric {
  name: string;
  model: string;
  keys_total: number;
  keys_available: number;
  keys_in_cooldown: number;
  in_cooldown: boolean;
  circuit_state: string;
  avg_latency_ms: number;
  success_rate: number;
  configured: boolean;
}

function ProviderStatusRow({ provider }: { provider: ProviderMetric }) {
  const successPct = Math.round(provider.success_rate * 100);
  const label = provider.name.charAt(0).toUpperCase() + provider.name.slice(1);
  const cooled = provider.in_cooldown || provider.circuit_state === 'open';

  return (
    <div
      className={`rounded-lg border p-2.5 transition-opacity ${
        cooled ? 'border-white/5 opacity-45' : 'border-cyan-500/15'
      }`}
      style={{
        background: 'rgba(8, 10, 18, 0.55)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      data-testid={`provider-row-${provider.name}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <span className="text-xs font-semibold text-cyan-200">{label}</span>
          <span className="text-[8px] font-mono text-white/25 ml-2">{provider.model}</span>
        </div>
        <span
          className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border ${
            cooled
              ? 'border-white/10 text-white/30'
              : provider.circuit_state === 'half_open'
                ? 'border-amber-500/30 text-amber-300/80'
                : 'border-emerald-500/25 text-emerald-300/80'
          }`}
        >
          {cooled ? 'cooldown' : provider.circuit_state}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[9px] font-mono text-white/40">
        <span>{provider.avg_latency_ms.toFixed(0)}ms avg</span>
        <span>{successPct}% ok</span>
        <span>
          {provider.keys_available}/{provider.keys_total} keys
        </span>
      </div>
      <UsageBar
        label="Success rate"
        pct={successPct}
        detail={`${successPct}%`}
        warn={successPct < 70}
      />
    </div>
  );
}

interface RoutingMatrixPanelProps {
  className?: string;
}

export default function RoutingMatrixPanel({ className = '' }: RoutingMatrixPanelProps) {
  const [matrix, setMatrix] = useState<RoutingMatrix | null>(null);
  const [failoverEvents, setFailoverEvents] = useState<
    Array<{ provider: string; reason: string; status_code?: number; latency_ms: number; ts: number }>
  >([]);
  const [routerMetrics, setRouterMetrics] = useState<{
    total_decisions?: number;
    current_accuracy?: number;
    recent_accuracy?: number;
  } | null>(null);
  const [providerMetrics, setProviderMetrics] = useState<ProviderMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers/routing', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok && data.matrix) setMatrix(data.matrix);
      if (Array.isArray(data.failoverEvents)) setFailoverEvents(data.failoverEvents);
      if (data.routerMetrics && typeof data.routerMetrics === 'object') {
        setRouterMetrics(data.routerMetrics as typeof routerMetrics);
      }
      const pm = data.providerMetrics as { providers?: ProviderMetric[] } | null;
      if (pm && Array.isArray(pm.providers)) {
        setProviderMetrics(pm.providers);
      }
    } catch (e) {
      setMsg(`Load failed: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [load]);

  const applyPreset = (preset: 'local_grunt' | 'cheap' | 'max_quality') => {
    if (!matrix) return;
    const next = matrix.routes.map((r) => {
      if (preset === 'local_grunt') {
        if (r.role === 'architect' || r.role === 'planning' || r.role === 'validation') {
          return { ...r, provider: 'azure', model: 'DeepSeek-V4-Flash', enabled: true };
        }
        return {
          ...r,
          provider: 'ollama',
          model: r.role === 'coding' ? 'deepseek-r1-0528-qwen3:8b' : 'qwen2.5:14b',
          dailyBudgetUsd: Math.min(r.dailyBudgetUsd, 2),
          enabled: true,
        };
      }
      if (preset === 'cheap') {
        return {
          ...r,
          provider: r.role === 'architect' ? 'azure' : 'ollama',
          model: r.role === 'architect' ? 'DeepSeek-V4-Flash' : 'llama3.1:8b',
          rpmLimit: Math.min(r.rpmLimit, 40),
          dailyBudgetUsd: Math.min(r.dailyBudgetUsd, 3),
          maxConcurrent: Math.min(r.maxConcurrent, 4),
          enabled: true,
        };
      }
      // max_quality
      return {
        ...r,
        provider: r.role === 'coding' || r.role === 'execution' ? 'ollama' : 'azure',
        model:
          r.role === 'architect'
            ? 'DeepSeek-V4-Pro'
            : r.role === 'coding'
              ? 'qwen2.5:32b'
              : 'DeepSeek-V4-Flash',
        dailyBudgetUsd: Math.max(r.dailyBudgetUsd, 15),
        rpmLimit: Math.max(r.rpmLimit, 60),
        enabled: true,
      };
    });
    setMatrix({ ...matrix, routes: next });
    setMsg(`Preset “${preset.replace('_', ' ')}” applied — Save to persist`);
  };

  const updateRoute = (role: AgentRole, next: RoleRoute) => {
    if (!matrix) return;
    setMatrix({
      ...matrix,
      routes: matrix.routes.map((r) => (r.role === role ? next : r)),
    });
  };

  const save = async () => {
    if (!matrix) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/providers/routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routes: matrix.routes, syncEngine: true }),
      });
      const data = await res.json();
      if (data.matrix) setMatrix(data.matrix);
      setMsg(
        data.engineSynced
          ? 'Saved & synced to engine'
          : `Saved locally${data.engineError ? ` · engine: ${data.engineError}` : ' · engine offline'}`
      );
    } catch (e) {
      setMsg(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const resetUsage = async () => {
    const res = await fetch('/api/providers/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    const data = await res.json();
    if (data.matrix) setMatrix(data.matrix);
    setMsg('Usage counters reset');
  };

  const totalSpend = matrix?.usage.reduce((s, u) => s + u.spendUsd, 0) || 0;
  const totalBudget = matrix?.routes.reduce((s, r) => s + (r.enabled ? r.dailyBudgetUsd : 0), 0) || 0;

  return (
    <div
      className={`flex flex-col gap-4 min-h-0 rounded-xl border border-white/[0.06] p-4 ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-cyan-400 uppercase tracking-wide flex items-center gap-2">
            <Settings className="w-4 h-4" /> Role → Model / Quota
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Route each agent role to a provider, model, RPM, daily $, and concurrency. Fallbacks fire when primary is throttled.
            {routerMetrics && (
              <span className="block mt-1 text-[10px] font-mono text-cyan-300/70">
                Router: {routerMetrics.total_decisions ?? 0} decisions ·{' '}
                {Math.round((routerMetrics.current_accuracy ?? routerMetrics.recent_accuracy ?? 0) * 100)}%
                accuracy
              </span>
            )}
            {' '}
            <span className="text-slate-500">
              {AGENT_ROLES.length} fleet roles map into these {matrix?.routes.length ?? 7} routing lanes — see Lab → Fleet Roles.
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <div className="flex gap-1 mr-1">
            {(
              [
                ['local_grunt', 'Local'],
                ['cheap', 'Cheap'],
                ['max_quality', 'Max'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => applyPreset(id)}
                className="tactile-chip px-2 py-1 text-[9px] font-mono uppercase"
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={load}
            className="tactile-ghost p-2 text-cyan-400/70"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={resetUsage}
            className="tactile-icon border border-white/10"
            title="Reset usage"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            disabled={saving || !matrix}
            onClick={save}
            className="tactile-ghost inline-flex items-center gap-1.5 px-3 py-2 text-cyan-300 text-xs font-semibold uppercase"
          >
            {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
        </div>
      </div>

      {matrix && (
        <div className="flex flex-wrap gap-3 text-[10px] font-mono text-white/40">
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-cyan-500/15 bg-cyan-500/5">
            <Zap size={10} className="text-cyan-400" />
            {matrix.routes.filter((r) => r.enabled).length} roles active
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10">
            <DollarSign size={10} />
            ${totalSpend.toFixed(2)} / ${totalBudget.toFixed(0)} today
          </span>
          <span className="text-white/25">updated {new Date(matrix.updatedAt).toLocaleTimeString()}</span>
        </div>
      )}

      {msg && (
        <div className="text-[11px] font-mono text-cyan-300/70 px-2 py-1.5 rounded border border-cyan-500/15 bg-cyan-500/5">
          {msg}
        </div>
      )}

      {failoverEvents.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-1.5">
          <div className="text-[9px] font-mono uppercase text-amber-300/80 flex items-center gap-1.5">
            <Zap size={10} /> Live failover events
          </div>
          {failoverEvents.slice(0, 8).map((ev, i) => (
            <div
              key={`${ev.provider}-${ev.ts}-${i}`}
              className="text-[10px] font-mono text-white/50 flex justify-between gap-2"
            >
              <span>
                <span className="text-amber-200">{ev.provider}</span> · {ev.reason}
                {ev.status_code ? ` (${ev.status_code})` : ''}
              </span>
              <span className="text-white/30 shrink-0">
                {ev.latency_ms.toFixed(0)}ms · {new Date(ev.ts * 1000).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {providerMetrics.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono uppercase text-cyan-300/70 flex items-center gap-1.5">
            <Gauge size={10} /> Provider health (live)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {providerMetrics.map((p) => (
              <ProviderStatusRow key={p.name} provider={p} />
            ))}
          </div>
        </div>
      )}

      <RouterProbabilityPanel refreshIntervalMs={2000} />

      {loading && !matrix ? (
        <div className="flex-1 flex items-center justify-center text-xs text-white/30 font-mono">
          <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading matrix…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 min-h-0">
          {matrix?.routes.map((route) => (
            <RouteRow
              key={route.role}
              route={route}
              usage={matrix.usage.find((u) => u.role === route.role)}
              onChange={(next) => updateRoute(route.role, next)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
