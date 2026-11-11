'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Plus,
  RefreshCw,
  Save,
  Search,
  X,
  Zap,
} from 'lucide-react';
import RequireAuth from '@/components/auth/RequireAuth';
import ConsoleShell from '@/components/ConsoleShell';
import {
  AGENT_ROLES,
  TIER_BADGE_CLASS,
  TIER_LABELS,
  type AgentRole,
} from '@/lib/agentRoles';
import { PROVIDER_TEMPLATES, templateByType } from '@/lib/providerTemplates';
import {
  autoAssignRoleBindings,
  newOptionId,
  normalizeBindings,
  type RoleBinding,
} from '@/lib/roleBindings';

/* ── Types ──────────────────────────────────────────────────────────── */

interface ProviderEntry {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  endpoint: string;
  models: string[];
  quota: {
    rpm: number;
    tpm: number;
    dailyBudget: number;
    maxConcurrency: number;
  };
  enabled: boolean;
  gpuRam?: {
    totalGb: number;
    perInstanceGb: number;
    maxInstances: number;
  };
  hasApiKey?: boolean;
  apiKeySet?: boolean;
}

interface RoleAllocation {
  roleId: string;
  percent: number;
  useGeneralPurpose: boolean;
}

interface ProviderAllocation {
  providerId: string;
  percent: number;
  roles: RoleAllocation[];
}

const QUOTA_DEFAULTS = { rpm: 30, tpm: 50000, dailyBudget: 20, maxConcurrency: 4 };

const CATEGORY_ORDER = ['cloud', 'gateway', 'enterprise', 'local'] as const;
const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  cloud: 'Cloud',
  gateway: 'Gateways & BYO',
  enterprise: 'Enterprise',
  local: 'Local / self-hosted',
};

function defaultRoleAllocs(): RoleAllocation[] {
  const equal = Math.round(100 / AGENT_ROLES.length);
  return AGENT_ROLES.map((r) => ({
    roleId: r.id,
    percent: equal,
    useGeneralPurpose: true,
  }));
}

type ToastTone = 'success' | 'error' | 'info';

function formatRoleName(id: string): string {
  return AGENT_ROLES.find((r) => r.id === id)?.name ?? id;
}

/* ── Small shared inputs ────────────────────────────────────────────── */

/** Draft-friendly number field — clears/types without snapping back to 0. */
function EditableNumber({
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    let n = Number.parseFloat(draft);
    if (!Number.isFinite(n)) n = value;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    if (step >= 1) n = Math.round(n);
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };

  return (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.-]/g, ''))}
        onBlur={commit}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono tabular-nums"
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[var(--day-faint)]">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? 'bg-emerald-500' : 'bg-[var(--day-border-strong)]'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/* ── Provider card (Tab 1, left column) ─────────────────────────────── */

function ProviderCard({
  provider,
  expanded,
  onExpand,
  onUpdate,
  onRemove,
}: {
  provider: ProviderEntry;
  expanded: boolean;
  onExpand: () => void;
  onUpdate: (updates: Partial<ProviderEntry>) => void;
  onRemove: () => void;
}) {
  // Local draft for the models textarea so commas/spaces type naturally.
  const [modelsDraft, setModelsDraft] = useState(provider.models.join(', '));

  const onModelsChange = (raw: string) => {
    setModelsDraft(raw);
    onUpdate({
      models: raw
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    });
  };

  const keySaved = Boolean(provider.hasApiKey || provider.apiKeySet);

  return (
    <div className="rounded-xl border border-[var(--day-border)] bg-[var(--day-accent-soft)] overflow-hidden">
      {/* Header — click anywhere to expand/collapse */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.03]"
        onClick={onExpand}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            provider.enabled ? 'bg-emerald-400' : 'bg-[var(--day-faint)]'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100 truncate">{provider.name}</div>
          <div className="text-[10px] font-mono text-[var(--day-faint)] uppercase tracking-wider truncate">
            {provider.type}
          </div>
        </div>
        <span className="shrink-0 px-2 py-0.5 rounded-full bg-white/[0.05] border border-[var(--day-border)] text-[10px] font-mono text-[var(--day-muted)]">
          {provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}
        </span>
        <div onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={provider.enabled}
            onChange={(v) => onUpdate({ enabled: v })}
            label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
          />
        </div>
        <button
          type="button"
          aria-label={`Remove ${provider.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="p-1.5 rounded-lg text-[var(--day-faint)] hover:text-rose-400 hover:bg-rose-500/10"
        >
          <X size={14} />
        </button>
        {expanded ? (
          <ChevronDown size={14} className="text-[var(--day-faint)]" />
        ) : (
          <ChevronRight size={14} className="text-[var(--day-faint)]" />
        )}
      </div>

      {/* Expandable body — CSS max-height transition */}
      <div
        className={`transition-[max-height] duration-300 ease-in-out overflow-hidden ${
          expanded ? 'max-h-[900px]' : 'max-h-0'
        }`}
      >
        <div className="px-4 pb-4 pt-3 space-y-3 border-t border-[var(--day-border)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono uppercase text-[var(--day-faint)] block mb-1.5">
                Name
              </label>
              <input
                type="text"
                value={provider.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase text-[var(--day-faint)] block mb-1.5">
                Endpoint
              </label>
              <input
                type="text"
                value={provider.endpoint}
                placeholder="https://…/v1"
                onChange={(e) => onUpdate({ endpoint: e.target.value })}
                className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] font-mono uppercase text-[var(--day-faint)] block mb-1.5">
              Models (comma-separated)
            </label>
            <textarea
              rows={2}
              value={modelsDraft}
              onChange={(e) => onModelsChange(e.target.value)}
              placeholder="model-a, model-b, …"
              className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono resize-y"
            />
          </div>

          <div>
            <label className="text-[10px] font-mono uppercase text-[var(--day-faint)] block mb-1.5">
              API key{' '}
              {keySaved ? (
                <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] normal-case">
                  (saved)
                </span>
              ) : null}
            </label>
            <input
              type="password"
              value={provider.apiKey}
              autoComplete="off"
              placeholder={keySaved ? 'Leave blank to keep existing key' : 'sk-…'}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] font-mono uppercase text-[var(--day-faint)] block mb-1.5">
              Rate limits
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <EditableNumber
                value={provider.quota.rpm}
                min={0}
                onCommit={(rpm) => onUpdate({ quota: { ...provider.quota, rpm } })}
              />
              <EditableNumber
                value={provider.quota.tpm}
                min={0}
                onCommit={(tpm) => onUpdate({ quota: { ...provider.quota, tpm } })}
              />
              <EditableNumber
                value={provider.quota.dailyBudget}
                min={0}
                onCommit={(dailyBudget) =>
                  onUpdate({ quota: { ...provider.quota, dailyBudget } })
                }
              />
              <EditableNumber
                value={provider.quota.maxConcurrency}
                min={1}
                onCommit={(maxConcurrency) =>
                  onUpdate({ quota: { ...provider.quota, maxConcurrency } })
                }
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
              {['RPM', 'TPM', '$/day', 'conc.'].map((s) => (
                <div
                  key={s}
                  className="text-[9px] font-mono uppercase text-[var(--day-faint)] text-center"
                >
                  {s}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Add Provider panel (Tab 1, right column) ───────────────────────── */

function AddProviderPanel({
  existingTypes,
  onAddTemplate,
  onCreateCustom,
}: {
  existingTypes: Set<string>;
  onAddTemplate: (type: string) => void;
  onCreateCustom: (draft: {
    name: string;
    endpoint: string;
    apiKey: string;
    models: string;
  }) => void;
}) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState({ name: '', endpoint: '', apiKey: '', models: '' });

  const q = query.trim().toLowerCase();
  const filtered = q
    ? PROVIDER_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.type.toLowerCase().includes(q) ||
          t.models.some((m) => m.toLowerCase().includes(q)),
      )
    : PROVIDER_TEMPLATES;

  const customValid = custom.name.trim().length > 0;

  return (
    <div className="rounded-xl border border-[var(--day-border)] bg-[var(--day-accent-soft)] p-4 space-y-3 lg:sticky lg:top-6">
      <div className="flex items-center gap-2">
        <Plus size={14} className="text-[var(--day-muted)]" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
          Add Provider
        </h3>
      </div>

      <div className="relative">
        <Search
          size={13}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--day-faint)]"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search catalog…"
          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full pl-8 pr-3 py-2 text-sm"
        />
      </div>

      <div className="max-h-[380px] overflow-y-auto pr-1 space-y-4">
        {filtered.length === 0 && (
          <p className="text-xs text-[var(--day-muted)] text-center py-6">
            No catalog providers match “{query}”.
          </p>
        )}
        {CATEGORY_ORDER.map((cat) => {
          const templates = filtered.filter((t) => (t.category || 'cloud') === cat);
          if (!templates.length) return null;
          return (
            <div key={cat} className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--day-faint)]">
                {CATEGORY_LABELS[cat]}
              </div>
              {templates.map((t) => {
                const added = existingTypes.has(t.type);
                return (
                  <div
                    key={t.type}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--day-border)] bg-white/[0.02]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-zinc-200 truncate">{t.name}</div>
                      <div className="text-[10px] font-mono text-[var(--day-faint)] truncate">
                        {t.type} · {t.models.length}{' '}
                        {t.models.length === 1 ? 'model' : 'models'}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={added}
                      onClick={() => onAddTemplate(t.type)}
                      className={`shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium ${
                        added
                          ? 'text-[var(--day-faint)] cursor-default'
                          : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25'
                      }`}
                    >
                      {added ? 'Added' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Custom provider */}
      <div className="pt-3 border-t border-[var(--day-border)] space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--day-faint)]">
          Add Custom Provider
        </div>
        <input
          type="text"
          value={custom.name}
          onChange={(e) => setCustom({ ...custom, name: e.target.value })}
          placeholder="Name"
          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={custom.endpoint}
          onChange={(e) => setCustom({ ...custom, endpoint: e.target.value })}
          placeholder="Endpoint (https://…/v1)"
          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
        />
        <input
          type="password"
          value={custom.apiKey}
          autoComplete="off"
          onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })}
          placeholder="API key (optional)"
          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={custom.models}
          onChange={(e) => setCustom({ ...custom, models: e.target.value })}
          placeholder="Models (comma-separated)"
          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
        />
        <button
          type="button"
          disabled={!customValid}
          onClick={() => {
            onCreateCustom(custom);
            setCustom({ name: '', endpoint: '', apiKey: '', models: '' });
          }}
          className="rounded-r-sm bg-accent text-bg-0 font-medium hover:bg-accent-strong w-full text-xs px-4 py-2 disabled:opacity-40"
        >
          Create
        </button>
      </div>
    </div>
  );
}

/* ── Role card (Tab 2) ──────────────────────────────────────────────── */

function RoleCard({
  role,
  providers,
  binding,
  predicted,
  onChange,
}: {
  role: AgentRole;
  providers: ProviderEntry[];
  binding: RoleBinding | undefined;
  predicted: RoleBinding | undefined;
  onChange: () => void;
}) {
  const manual = binding?.mode === 'manual' && binding.options.length > 0;
  const primary = manual ? binding!.options[0] : predicted?.options[0];
  const primaryProvider = primary
    ? providers.find((p) => p.id === primary.providerId)
    : undefined;

  let assignment: string;
  let sub: string;
  if (manual) {
    assignment = `${primaryProvider?.name ?? 'Missing provider'} — ${
      primary!.model || primaryProvider?.models[0] || 'default'
    }`;
    const extra = binding!.options.length - 1;
    sub = extra > 0 ? `Manual · +${extra} fallback${extra === 1 ? '' : 's'}` : 'Manual binding';
  } else {
    assignment = 'Auto-select (recommended)';
    const p = predicted?.options[0];
    const pp = p ? providers.find((x) => x.id === p.providerId) : undefined;
    sub =
      p && pp
        ? `Would use ${pp.name} — ${p.model || pp.models[0] || 'default'}`
        : 'No enabled providers yet';
  }

  return (
    <div className="rounded-xl border border-[var(--day-border)] bg-[var(--day-accent-soft)] p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={`w-8 h-8 rounded-lg bg-gradient-to-br ${role.color} flex items-center justify-center shrink-0 bg-opacity-20`}
        >
          <role.icon size={15} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100 truncate">{role.name}</div>
          <span
            className={`inline-block mt-1 px-1.5 py-0.5 rounded-full border text-[9px] font-mono uppercase tracking-wider ${TIER_BADGE_CLASS[role.model_tier]}`}
          >
            {TIER_LABELS[role.model_tier]}
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs text-zinc-200 font-mono truncate">{assignment}</div>
        <div className="text-[10px] text-[var(--day-faint)] font-mono truncate mt-0.5">{sub}</div>
      </div>
      <button
        type="button"
        onClick={onChange}
        className="rounded-r-sm border border-line-2 text-fg-2 hover:bg-bg-3 w-full text-xs px-3 py-1.5 inline-flex items-center justify-center gap-1.5"
      >
        <Zap size={12} />
        Change
      </button>
    </div>
  );
}

/* Provider lookup passed via props (no module state). */

/* ── Binding slide-over (Tab 2 "Change") ────────────────────────────── */

interface DraftOption {
  providerId: string;
  model: string;
}

function BindingSlideOver({
  open,
  role,
  providers,
  binding,
  predicted,
  onClose,
  onSave,
}: {
  open: boolean;
  role: AgentRole | null;
  providers: ProviderEntry[];
  binding: RoleBinding | undefined;
  predicted: RoleBinding | undefined;
  onClose: () => void;
  onSave: (binding: RoleBinding) => void;
}) {
  const [auto, setAuto] = useState(true);
  const [options, setOptions] = useState<DraftOption[]>([]);

  // Re-seed the draft whenever a role opens.
  useEffect(() => {
    if (open && role) {
      const seeded =
        binding?.mode === 'manual' && binding.options.length
          ? binding.options.map((o) => ({ providerId: o.providerId, model: o.model }))
          : (predicted?.options ?? []).map((o) => ({
              providerId: o.providerId,
              model: o.model,
            }));
      setAuto(binding?.mode !== 'manual');
      setOptions(seeded.length ? seeded : []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const enabledProviders = providers.filter((p) => p.enabled);
  const usedProviderIds = new Set(options.map((o) => o.providerId));
  const availableProviders = enabledProviders.filter((p) => !usedProviderIds.has(p.id));

  const setOption = (i: number, updates: Partial<DraftOption>) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...updates } : o)));
  };

  const predictedProvider =
    predicted?.options[0] != null
      ? enabledProviders.find((p) => p.id === predicted.options[0].providerId)
      : undefined;

  const handleSave = () => {
    if (!role) return;
    onSave({
      roleId: role.id,
      mode: auto ? 'auto' : 'manual',
      options: auto
        ? (predicted?.options ?? [])
        : options
            .filter((o) => o.providerId)
            .map((o) => ({ id: newOptionId(), providerId: o.providerId, model: o.model })),
    });
  };

  return (
    <div
      className={`fixed inset-0 z-[90] ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-0 h-full w-full max-w-md bg-[#0f0f16] border-l border-[var(--day-border)] shadow-2xl transition-transform duration-300 ease-out flex flex-col ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--day-border)]">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">
              {role?.name ?? 'Assign model'}
            </h3>
            <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--day-faint)] mt-0.5">
              {role ? `${TIER_LABELS[role.model_tier]} tier` : ''}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--day-muted)] hover:text-zinc-100 hover:bg-white/[0.05]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Auto toggle */}
          <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--day-border)] bg-white/[0.02]">
            <div>
              <div className="text-xs font-medium text-zinc-100">
                Auto-select best provider for this role
              </div>
              <div className="text-[10px] text-[var(--day-faint)] mt-0.5">
                Matches providers to the{' '}
                {role ? TIER_LABELS[role.model_tier].toLowerCase() : ''} tier
              </div>
            </div>
            <Toggle checked={auto} onChange={setAuto} label="Auto-select" />
          </div>

          {auto ? (
            <div className="p-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] space-y-2">
              <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300">
                Recommended pick
              </div>
              {predictedProvider && predicted?.options[0] ? (
                <>
                  <div className="text-sm text-zinc-100 font-mono">
                    {predictedProvider.name} —{' '}
                    {predicted.options[0].model || predictedProvider.models[0] || 'default'}
                  </div>
                  <p className="text-[11px] text-[var(--day-muted)]">
                    Based on model tier {role ? TIER_LABELS[role.model_tier].toLowerCase() : ''}{' '}
                    and enabled providers.
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-[var(--day-muted)]">
                  No enabled providers match this tier yet. Enable providers in My Providers, or
                  switch auto off and pick manually.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {enabledProviders.length === 0 && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                  No enabled providers. Enable one in My Providers first.
                </p>
              )}
              {options.map((opt, i) => {
                const provider = providers.find((p) => p.id === opt.providerId);
                const noModels = !provider || provider.models.length === 0;
                return (
                  <div
                    key={i}
                    className="p-3 rounded-xl border border-[var(--day-border)] bg-white/[0.02] space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--day-faint)]">
                        {i === 0 ? 'Primary' : `Fallback ${i}`}
                      </span>
                      {i > 0 && (
                        <button
                          type="button"
                          aria-label={`Remove fallback ${i}`}
                          onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}
                          className="p-1 rounded text-[var(--day-faint)] hover:text-rose-400"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <select
                      value={opt.providerId}
                      onChange={(e) => {
                        const next = providers.find((p) => p.id === e.target.value);
                        setOption(i, {
                          providerId: e.target.value,
                          model: next?.models[0] ?? '',
                        });
                      }}
                      className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm"
                    >
                      <option value="">Select provider…</option>
                      {(i === 0 ? enabledProviders : availableProviders).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.models.length === 0 ? ' (no models)' : ''}
                        </option>
                      ))}
                    </select>
                    {opt.providerId &&
                      (noModels ? (
                        <input
                          type="text"
                          value={opt.model}
                          onChange={(e) => setOption(i, { model: e.target.value })}
                          placeholder="Model id (provider has no models)"
                          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
                        />
                      ) : (
                        <select
                          value={opt.model}
                          onChange={(e) => setOption(i, { model: e.target.value })}
                          className="rounded-r-sm border border-line-2 bg-bg-2 text-fg-1 placeholder:text-fg-4 focus:outline-none focus:border-accent w-full px-3 py-2 text-sm font-mono"
                        >
                          {provider!.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ))}
                  </div>
                );
              })}

              {options.length < 3 && enabledProviders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setOptions((prev) => [...prev, { providerId: '', model: '' }])}
                  className="rounded-r-sm border border-line-2 text-fg-2 hover:bg-bg-3 w-full text-xs px-3 py-2"
                >
                  <Plus size={12} className="inline mr-1" />
                  Add fallback ({options.length}/3)
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-[var(--day-border)]">
          <button type="button" onClick={onClose} className="flex-1 rounded-r-sm border border-line-2 text-fg-2 hover:bg-bg-3 text-xs px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!auto && options.every((o) => !o.providerId)}
            className="flex-1 rounded-r-sm bg-accent text-bg-0 font-medium hover:bg-accent-strong text-xs px-4 py-2 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────── */

const ADMIN_EMAIL = 'yaeger.james42@gmail.com';
const ADMIN_MODAL_KEY = 'swarmagents-admin-yaeger-2026';
const ADMIN_MODAL_ENDPOINT =
  'https://yaeger--ep-gemma-4-31b-it-admin-server-fastapi-app.modal.run/v1';

function SettingsPageInner() {
  const [activeTab, setActiveTab] = useState<'providers' | 'roles'>('providers');
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [allocations, setAllocations] = useState<ProviderAllocation[]>([]);
  const [roleBindings, setRoleBindings] = useState<RoleBinding[]>(() => normalizeBindings([]));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [slideOpen, setSlideOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: ToastTone; msg: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, tone: ToastTone = 'info') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ tone, msg });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const markDirty = useCallback(() => setDirty(true), []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Admin account: pre-fill the Modal admin key/endpoint if missing.
      let currentUserEmail = '';
      try {
        const { getStoredUser } = await import('@/lib/auth');
        currentUserEmail = getStoredUser()?.email || '';
      } catch {
        /* ignore */
      }
      const isAdmin = currentUserEmail === ADMIN_EMAIL;

      const res = await fetch('/api/providers/config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.engineError || `HTTP ${res.status}`);
      }
      setUpdatedAt(data.updatedAt || null);

      const loaded: ProviderEntry[] = (data.providers || []).map(
        (p: Record<string, unknown>) => ({
          id: String(p.id),
          name: String(p.name || 'Provider'),
          type: String(p.type || 'custom'),
          apiKey: '',
          endpoint: String(p.endpoint || ''),
          models: Array.isArray(p.models) ? p.models.map(String) : [],
          quota: {
            rpm: Number((p.quota as ProviderEntry['quota'])?.rpm ?? 30),
            tpm: Number((p.quota as ProviderEntry['quota'])?.tpm ?? 50000),
            dailyBudget: Number((p.quota as ProviderEntry['quota'])?.dailyBudget ?? 0),
            maxConcurrency: Number((p.quota as ProviderEntry['quota'])?.maxConcurrency ?? 2),
          },
          enabled: p.enabled !== false,
          gpuRam: p.gpuRam as ProviderEntry['gpuRam'],
          hasApiKey: Boolean(p.hasApiKey || p.apiKeySet),
          apiKeySet: Boolean(p.hasApiKey || p.apiKeySet),
        }),
      );

      if (isAdmin) {
        const modalEntry = loaded.find((p) => p.type === 'modal');
        if (modalEntry && !modalEntry.hasApiKey) {
          modalEntry.apiKey = ADMIN_MODAL_KEY;
          modalEntry.endpoint = ADMIN_MODAL_ENDPOINT;
          modalEntry.enabled = true;
          modalEntry.hasApiKey = true;
        }
      }
      setProviders(loaded);

      if (Array.isArray(data.allocations) && data.allocations.length) {
        setAllocations(data.allocations as ProviderAllocation[]);
      } else if (loaded.length) {
        const equal = Math.round(100 / loaded.length);
        setAllocations(
          loaded.map((p) => ({
            providerId: p.id,
            percent: equal,
            roles: defaultRoleAllocs(),
          })),
        );
      } else {
        setAllocations([]);
      }

      setRoleBindings(normalizeBindings(data.roleBindings));
      setDirty(false);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* Derived */
  const existingTypes = useMemo(() => new Set(providers.map((p) => p.type)), [providers]);

  const predictedBindings = useMemo(
    () => autoAssignRoleBindings(providers, allocations, roleBindings),
    [providers, allocations, roleBindings],
  );

  const validationError = useMemo(() => {
    for (const p of providers) {
      if (!p.name.trim()) return 'Every provider needs a name';
      if (p.enabled && !p.endpoint.trim() && p.type !== 'ollama') {
        return `${p.name}: endpoint required when enabled`;
      }
      const needsKey = PROVIDER_TEMPLATES.find((t) => t.type === p.type)?.needsKey;
      if (p.enabled && needsKey && !p.hasApiKey && !p.apiKey.trim()) {
        return `${p.name}: API key required`;
      }
    }
    return null;
  }, [providers]);

  /* Provider actions */
  const updateProvider = useCallback(
    (id: string, updates: Partial<ProviderEntry>) => {
      setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
      setDirty(true);
    },
    [],
  );

  const removeProvider = useCallback(
    (id: string) => {
      const gone = providers.find((p) => p.id === id);
      setProviders((prev) => prev.filter((p) => p.id !== id));
      setAllocations((prev) => prev.filter((a) => a.providerId !== id));
      setDirty(true);
      showToast(`Removed ${gone?.name ?? 'provider'} — press Save to persist`, 'info');
    },
    [providers, showToast],
  );

  const addProviderFromTemplate = useCallback(
    (type: string) => {
      const template = templateByType(type);
      if (!template || existingTypes.has(type)) return;
      const newProvider: ProviderEntry = {
        id: `p${Date.now()}`,
        name: template.name,
        type: template.type,
        apiKey: '',
        endpoint: template.defaultEndpoint,
        models: [...template.models],
        quota: { ...QUOTA_DEFAULTS },
        enabled: true,
        hasApiKey: false,
        ...(template.category === 'local'
          ? { gpuRam: { totalGb: 12, perInstanceGb: 6, maxInstances: 2 } }
          : {}),
      };
      setProviders((prev) => [...prev, newProvider]);
      setAllocations((prev) => {
        const next = [
          ...prev,
          { providerId: newProvider.id, percent: 0, roles: defaultRoleAllocs() },
        ];
        const equal = Math.round(100 / next.length);
        return next.map((a) => ({ ...a, percent: equal }));
      });
      setExpandedProvider(newProvider.id);
      setDirty(true);
      showToast(`Added ${template.name} — configure & save`, 'success');
    },
    [existingTypes, showToast],
  );

  const createCustomProvider = useCallback(
    (draft: { name: string; endpoint: string; apiKey: string; models: string }) => {
      const newProvider: ProviderEntry = {
        id: `p${Date.now()}-custom`,
        name: draft.name.trim(),
        type: 'custom',
        apiKey: draft.apiKey.trim(),
        endpoint: draft.endpoint.trim(),
        models: draft.models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        quota: { ...QUOTA_DEFAULTS },
        enabled: true,
        hasApiKey: Boolean(draft.apiKey.trim()),
      };
      setProviders((prev) => [...prev, newProvider]);
      setAllocations((prev) => {
        const next = [
          ...prev,
          { providerId: newProvider.id, percent: 0, roles: defaultRoleAllocs() },
        ];
        const equal = Math.round(100 / next.length);
        return next.map((a) => ({ ...a, percent: equal }));
      });
      setExpandedProvider(newProvider.id);
      setDirty(true);
      showToast(`Created ${newProvider.name} — press Save to persist`, 'success');
    },
    [showToast],
  );

  /* Role binding actions */
  const autoAssignAll = useCallback(() => {
    const next = autoAssignRoleBindings(providers, allocations, roleBindings);
    setRoleBindings(next);
    setDirty(true);
    showToast(`Auto-assigned all ${AGENT_ROLES.length} roles`, 'success');
  }, [providers, allocations, roleBindings, showToast]);

  const saveBinding = useCallback(
    (binding: RoleBinding) => {
      setRoleBindings((prev) => {
        const exists = prev.some((b) => b.roleId === binding.roleId);
        return exists ? prev.map((b) => (b.roleId === binding.roleId ? binding : b)) : [...prev, binding];
      });
      setDirty(true);
      setSlideOpen(false);
      showToast(`Saved ${formatRoleName(binding.roleId)} binding`, 'success');
    },
    [showToast],
  );

  const openBinding = useCallback((roleId: string) => {
    setEditingRoleId(roleId);
    setSlideOpen(true);
  }, []);

  const closeBinding = useCallback(() => {
    setSlideOpen(false);
    setTimeout(() => setEditingRoleId(null), 320);
  }, []);

  /* Save flow */
  const handleSave = async () => {
    if (validationError) {
      showToast(validationError, 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/providers/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providers: providers.map((p) => ({
            ...p,
            apiKey: p.apiKey.trim() || undefined,
          })),
          allocations,
          roleBindings,
          syncEngine: true,
          reload: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Save failed');
      }

      // Best-effort: push role→provider hints into the engine routing matrix.
      try {
        const matrixRoles = [
          'architect',
          'planning',
          'coding',
          'research',
          'validation',
          'browser',
          'execution',
        ] as const;

        const mapUiToMatrix = (roleId: string): (typeof matrixRoles)[number] => {
          if (roleId === 'architect') return 'architect';
          if (roleId === 'researcher') return 'research';
          if (roleId === 'verifier' || roleId === 'qa-engineer') return 'validation';
          if (roleId === 'browser-agent') return 'browser';
          if (roleId === 'implementer' || roleId === 'debugger') return 'coding';
          if (roleId.includes('plan')) return 'planning';
          return 'execution';
        };

        const pickFromBindings = (matrixRole: (typeof matrixRoles)[number]) => {
          const uiRoles = AGENT_ROLES.filter((r) => mapUiToMatrix(r.id) === matrixRole);
          for (const role of uiRoles) {
            const binding = roleBindings.find((b) => b.roleId === role.id);
            if (binding?.options?.length) {
              const primary = binding.options[0];
              const provider = providers.find((p) => p.id === primary.providerId);
              if (provider) {
                const fallbacks = binding.options.slice(1).map((o) => {
                  const fp = providers.find((p) => p.id === o.providerId);
                  const model = o.model || fp?.models?.[0] || '';
                  return `${fp?.type || 'custom'}:${model}`;
                });
                return {
                  provider,
                  model: primary.model || provider.models[0] || '',
                  fallbacks,
                };
              }
            }
          }
          return null;
        };

        const pickProvider = (matrixRole: (typeof matrixRoles)[number]) => {
          const bound = pickFromBindings(matrixRole);
          if (bound) return bound;
          const fallback = allocations.slice().sort((a, b) => b.percent - a.percent)[0];
          const provider = providers.find((p) => p.id === fallback?.providerId);
          if (!provider) return null;
          return { provider, model: provider.models[0] || '', fallbacks: [] as string[] };
        };

        const routes = matrixRoles.map((role) => {
          const picked = pickProvider(role);
          return {
            role,
            label: role,
            description: `${role} route from settings`,
            provider: picked?.provider?.type || 'ollama',
            model: picked?.model || '',
            fallbacks: picked?.fallbacks || [],
            rpmLimit: picked?.provider?.quota.rpm || 30,
            dailyBudgetUsd: picked?.provider?.quota.dailyBudget || 0,
            maxConcurrent: picked?.provider?.quota.maxConcurrency || 2,
            enabled: picked?.provider?.enabled !== false,
          };
        });

        await fetch('/api/providers/routing', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routes, syncEngine: false }),
        });
      } catch {
        /* routing sync optional */
      }

      // Clear local key drafts — the server stores them now.
      setProviders((prev) =>
        prev.map((p) => ({
          ...p,
          apiKey: '',
          hasApiKey: Boolean(p.apiKey.trim()) || p.hasApiKey,
          apiKeySet: Boolean(p.apiKey.trim()) || p.apiKeySet,
        })),
      );
      setDirty(false);
      setUpdatedAt(data.updatedAt || new Date().toISOString());

      const parts = ['Saved'];
      if (data.engineSynced) parts.push('providers synced');
      else if (data.engineError) parts.push('backend sync pending');
      if (data.engineReloaded) parts.push('reloaded');
      showToast(parts.join(' · '), 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const editingRole = editingRoleId
    ? AGENT_ROLES.find((r) => r.id === editingRoleId) ?? null
    : null;
  const editingBinding = editingRoleId
    ? roleBindings.find((b) => b.roleId === editingRoleId)
    : undefined;
  const editingPredicted = editingRoleId
    ? predictedBindings.find((b) => b.roleId === editingRoleId)
    : undefined;

  const settingsTrailing = (
    <>
      {dirty ? (
        <span className="text-[10px] font-mono uppercase text-amber-400 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 whitespace-nowrap">
          Unsaved
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || loading || !!validationError}
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-semibold transition disabled:opacity-40 ${
          dirty
            ? 'bg-amber-500 text-black hover:bg-amber-400'
            : 'bg-cyan-500 text-black hover:bg-cyan-400'
        }`}
      >
        {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
        Save
      </button>
    </>
  );

  return (
    <ConsoleShell missionHint="Settings — providers & role models" trailing={settingsTrailing}>
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Header: tabs + save state */}
        <div className="flex items-center justify-between gap-4 flex-wrap mb-8">
          <div className="flex gap-1 p-1 rounded-full bg-[var(--day-accent-soft)] border border-[var(--day-border)]">
            {(
              [
                { id: 'providers' as const, label: 'My Providers' },
                { id: 'roles' as const, label: 'Assign Models' },
              ]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`text-xs px-4 py-1.5 rounded-full font-medium transition ${
                  activeTab === tab.id
                    ? 'bg-white/10 text-zinc-100'
                    : 'text-[var(--day-muted)] hover:text-zinc-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {dirty ? (
              <span className="text-[10px] font-mono uppercase text-amber-400 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 whitespace-nowrap">
                Unsaved
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || !!validationError}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition disabled:opacity-40 ${
                dirty
                  ? 'bg-amber-500 text-black hover:bg-amber-400'
                  : 'bg-cyan-500 text-black hover:bg-cyan-400'
              }`}
            >
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </button>
          </div>
        </div>

        {loadError && (
          <div className="mb-6 p-3 rounded-xl border border-amber-500/30 bg-amber-950/40 text-amber-300 text-xs font-mono">
            Load warning: {loadError}
          </div>
        )}
        {validationError && dirty && (
          <div className="mb-6 p-3 rounded-xl border border-rose-500/30 bg-rose-950/40 text-rose-300 text-xs">
            {validationError}
          </div>
        )}

        {loading ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-16 rounded-xl bg-white/[0.03] border border-[var(--day-border)]" />
            <div className="h-16 rounded-xl bg-white/[0.03] border border-[var(--day-border)]" />
            <div className="h-16 rounded-xl bg-white/[0.03] border border-[var(--day-border)]" />
          </div>
        ) : activeTab === 'providers' ? (
          /* ── Tab 1: My Providers ── */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2 space-y-3">
              <p className="text-[11px] text-[var(--day-muted)]">
                {providers.length} configured · keys stay server-side
                {updatedAt ? ` · Last saved ${new Date(updatedAt).toLocaleString()}` : ''}
              </p>

              {!providers.length && (
                <div className="p-10 text-center rounded-xl border border-dashed border-[var(--day-border)] text-[var(--day-muted)] text-sm space-y-2">
                  <Plus size={20} className="mx-auto text-[var(--day-faint)]" />
                  <p>No providers yet. Add one from the catalog or create a custom provider.</p>
                </div>
              )}

              {providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  expanded={expandedProvider === provider.id}
                  onExpand={() =>
                    setExpandedProvider(expandedProvider === provider.id ? null : provider.id)
                  }
                  onUpdate={(updates) => updateProvider(provider.id, updates)}
                  onRemove={() => removeProvider(provider.id)}
                />
              ))}
            </div>

            <AddProviderPanel
              existingTypes={existingTypes}
              onAddTemplate={addProviderFromTemplate}
              onCreateCustom={createCustomProvider}
            />
          </div>
        ) : (
          /* ── Tab 2: Assign Models to Roles ── */
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-[var(--day-muted)]">
                Pick which provider + model powers each agent role.
              </p>
              <button
                type="button"
                onClick={autoAssignAll}
                disabled={!providers.some((p) => p.enabled)}
                className="rounded-r-sm border border-line-2 text-fg-2 hover:bg-bg-3 inline-flex items-center gap-1.5 text-xs px-3 py-2 disabled:opacity-40"
              >
                <Zap size={12} />
                Auto-assign all
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {AGENT_ROLES.map((role) => (
                <RoleCard
                  key={role.id}
                  role={role}
                  providers={providers}
                  binding={roleBindings.find((b) => b.roleId === role.id)}
                  predicted={predictedBindings.find((b) => b.roleId === role.id)}
                  onChange={() => openBinding(role.id)}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Role binding slide-over */}
      <BindingSlideOver
        open={slideOpen}
        role={editingRole}
        providers={providers}
        binding={editingBinding}
        predicted={editingPredicted}
        onClose={closeBinding}
        onSave={saveBinding}
      />

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-20 right-6 z-[95] px-4 py-2.5 rounded-xl text-xs font-mono flex items-center gap-2 border shadow-xl backdrop-blur-md ${
            toast.tone === 'success'
              ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300'
              : toast.tone === 'error'
                ? 'bg-rose-950/80 border-rose-500/40 text-rose-300'
                : 'bg-zinc-950/80 border-zinc-500/40 text-zinc-200'
          }`}
        >
          {toast.tone === 'success' ? (
            <CheckCircle2 size={14} />
          ) : toast.tone === 'error' ? (
            <AlertTriangle size={14} />
          ) : (
            <Info size={14} />
          )}
          {toast.msg}
        </div>
      )}
    </ConsoleShell>
  );
}

export default function SettingsPage() {
  return (
    <RequireAuth>
      <SettingsPageInner />
    </RequireAuth>
  );
}