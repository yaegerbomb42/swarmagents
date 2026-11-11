/**
 * Role → provider/model binding helpers (auto-assign + matching).
 */

import { AGENT_ROLES, type AgentRole } from '@/lib/agentRoles';
import type {
  StoredProvider,
  StoredProviderAllocation,
  StoredRoleBinding,
  StoredRoleModelOption,
} from '@/lib/providerStore';

export type RoleModelOption = StoredRoleModelOption;
export type RoleBinding = StoredRoleBinding;

export function newOptionId(): string {
  return `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyBindings(): RoleBinding[] {
  return AGENT_ROLES.map((r) => ({
    roleId: r.id,
    mode: 'auto' as const,
    options: [],
  }));
}

export function normalizeBindings(
  incoming: RoleBinding[] | undefined | null,
): RoleBinding[] {
  const byId = new Map((incoming || []).map((b) => [b.roleId, b]));
  return AGENT_ROLES.map((r) => {
    const existing = byId.get(r.id);
    if (!existing) {
      return { roleId: r.id, mode: 'auto' as const, options: [] };
    }
    return {
      roleId: r.id,
      mode: existing.mode === 'manual' ? 'manual' : 'auto',
      options: Array.isArray(existing.options)
        ? existing.options
            .filter((o) => o && o.providerId)
            .map((o) => ({
              id: o.id || newOptionId(),
              providerId: String(o.providerId),
              model: String(o.model || ''),
            }))
        : [],
    };
  });
}

function freqWeight(
  providerId: string,
  allocations: StoredProviderAllocation[],
): number {
  const a = allocations.find((x) => x.providerId === providerId);
  return Math.max(1, Number(a?.percent) || 1);
}

function scoreProviderForTier(
  provider: StoredProvider,
  tier: AgentRole['model_tier'],
  freq: number,
): number {
  const blob = `${provider.type} ${provider.name} ${(provider.models || []).join(' ')}`.toLowerCase();
  const isLocal = /ollama|lmstudio|vllm|local|llama\.cpp/.test(blob);
  const isFrontier =
    /claude|gpt-4|opus|sonnet|gemini-2|deepseek-v[34]|405b|70b|72b|pro|frontier|maverick/.test(
      blob,
    );
  const isLight = /7b|8b|9b|3b|1\.5b|mini|nano|haiku|flash|tiny|phi-3|phi-4-mini/.test(blob);

  let score = freq;
  if (tier === 'frontier') {
    score += isFrontier ? 55 : isLocal ? -25 : 12;
    if (isLight) score -= 20;
  } else if (tier === 'strong') {
    score += isFrontier ? 25 : isLight ? -8 : 18;
    if (isLocal && !isLight) score += 8;
  } else if (tier === 'medium') {
    score += isLocal ? 22 : isFrontier ? -4 : 14;
    if (isLight) score += 10;
  } else {
    score += isLocal || isLight ? 45 : -12;
  }
  if (!provider.enabled) score -= 100;
  return score;
}

function pickModelForTier(
  provider: StoredProvider,
  tier: AgentRole['model_tier'],
): string {
  const models = provider.models || [];
  if (!models.length) return '';
  const ranked = [...models].sort((a, b) => {
    const score = (m: string) => {
      const s = m.toLowerCase();
      const frontier = /70b|72b|405b|opus|sonnet|pro|v3|v4|maverick/.test(s) ? 3 : 0;
      const light = /7b|8b|mini|nano|haiku|flash|3b/.test(s) ? 3 : 0;
      if (tier === 'frontier') return frontier * 10 - light * 5;
      if (tier === 'light') return light * 10 - frontier * 5;
      if (tier === 'medium') return light * 4 + (frontier ? -2 : 2);
      return frontier * 4 + (light ? -1 : 2);
    };
    return score(b) - score(a);
  });
  return ranked[0] || '';
}

/** Build bindings for every role from enabled providers + frequency meters. */
export function autoAssignRoleBindings(
  providers: StoredProvider[],
  allocations: StoredProviderAllocation[],
  previous?: RoleBinding[],
): RoleBinding[] {
  const enabled = providers.filter((p) => p.enabled !== false);
  const prev = new Map((previous || []).map((b) => [b.roleId, b]));

  return AGENT_ROLES.map((role) => {
    const scored = enabled
      .map((p) => ({
        provider: p,
        score: scoreProviderForTier(p, role.model_tier, freqWeight(p.id, allocations)),
      }))
      .sort((a, b) => b.score - a.score);

    const options: RoleModelOption[] = [];
    for (const item of scored.slice(0, 3)) {
      if (item.score < -50) continue;
      options.push({
        id: newOptionId(),
        providerId: item.provider.id,
        model: pickModelForTier(item.provider, role.model_tier),
      });
    }

    const prior = prev.get(role.id);
    return {
      roleId: role.id,
      mode: 'auto' as const,
      options: options.length
        ? options
        : prior?.options?.length
          ? prior.options
          : [],
    };
  });
}

/** Match a seat title / role hint to a UI role binding. */
export function findBindingForHint(
  hint: string | undefined,
  bindings: RoleBinding[],
): RoleBinding | null {
  if (!hint || !bindings.length) return null;
  const h = hint.toLowerCase().trim();
  const exact = bindings.find((b) => b.roleId === hint || b.roleId === h);
  if (exact?.options?.length) return exact;

  for (const role of AGENT_ROLES) {
    const name = role.name.toLowerCase();
    if (
      h === role.id ||
      h.includes(role.id) ||
      h.includes(name) ||
      name.split(/\s+/).some((w) => w.length > 3 && h.includes(w))
    ) {
      const b = bindings.find((x) => x.roleId === role.id);
      if (b?.options?.length) return b;
    }
  }
  return null;
}

/** Weighted pick among bound options (earlier options get higher weight). */
export function pickBoundOption(
  binding: RoleBinding,
  providers: StoredProvider[],
): { provider: StoredProvider; model: string } | null {
  const usable = binding.options
    .map((o, i) => {
      const provider = providers.find((p) => p.id === o.providerId && p.enabled !== false);
      if (!provider) return null;
      const weight = Math.max(1, binding.options.length - i) * 3;
      return { provider, model: o.model || provider.models?.[0] || '', weight };
    })
    .filter(Boolean) as Array<{ provider: StoredProvider; model: string; weight: number }>;

  if (!usable.length) return null;
  const total = usable.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const item of usable) {
    r -= item.weight;
    if (r <= 0) return { provider: item.provider, model: item.model };
  }
  return { provider: usable[0].provider, model: usable[0].model };
}

export function preferModelOnProvider(
  provider: StoredProvider,
  model: string,
): StoredProvider {
  if (!model) return provider;
  const rest = (provider.models || []).filter((m) => m !== model);
  return { ...provider, models: [model, ...rest] };
}
