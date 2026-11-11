/**
 * Server-side persistence for dashboard provider settings.
 * API keys stay on the server; clients only see hasApiKey + masked hints.
 */

import { promises as fs } from 'fs';
import path from 'path';

export interface StoredProviderQuota {
  rpm: number;
  tpm: number;
  dailyBudget: number;
  maxConcurrency: number;
}

export interface StoredProvider {
  id: string;
  name: string;
  type: string;
  /** Stored only server-side; never returned raw to the client. */
  apiKey?: string;
  endpoint: string;
  models: string[];
  quota: StoredProviderQuota;
  enabled: boolean;
  gpuRam?: {
    totalGb: number;
    perInstanceGb: number;
    maxInstances: number;
  };
}

export interface StoredRoleAllocation {
  roleId: string;
  percent: number;
  useGeneralPurpose: boolean;
}

export interface StoredProviderAllocation {
  providerId: string;
  percent: number;
  roles: StoredRoleAllocation[];
}

/** Ordered provider/model options for a UI agent role (primary first). */
export interface StoredRoleModelOption {
  id: string;
  providerId: string;
  /** Empty string = provider default (first listed model). */
  model: string;
}

export interface StoredRoleBinding {
  roleId: string;
  mode: 'auto' | 'manual';
  options: StoredRoleModelOption[];
}

export interface ProvidersStore {
  version: 1;
  updatedAt: string;
  providers: StoredProvider[];
  allocations: StoredProviderAllocation[];
  /** Role → ordered provider/model options. Optional for older stores. */
  roleBindings?: StoredRoleBinding[];
}

const STORE_PATH = path.join(process.cwd(), '.data', 'providers.json');

const g = globalThis as typeof globalThis & {
  __swarmProvidersStore?: ProvidersStore;
};

function emptyStore(): ProvidersStore {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    providers: [],
    allocations: [],
  };
}

export async function loadProvidersStore(): Promise<ProvidersStore> {
  if (g.__swarmProvidersStore) return g.__swarmProvidersStore;
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ProvidersStore;
    if (parsed?.version === 1 && Array.isArray(parsed.providers)) {
      g.__swarmProvidersStore = parsed;
      return parsed;
    }
  } catch {
    /* missing */
  }
  const fresh = emptyStore();
  g.__swarmProvidersStore = fresh;
  return fresh;
}

export async function saveProvidersStore(store: ProvidersStore): Promise<void> {
  store.updatedAt = new Date().toISOString();
  store.version = 1;
  g.__swarmProvidersStore = store;
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    /* in-memory still usable */
  }
}

/** Public shape — never includes raw apiKey. */
export function toPublicProvider(p: StoredProvider) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    endpoint: p.endpoint,
    models: p.models,
    quota: p.quota,
    enabled: p.enabled,
    ...(p.gpuRam ? { gpuRam: p.gpuRam } : {}),
    hasApiKey: Boolean(p.apiKey && p.apiKey.trim()),
    apiKeySet: Boolean(p.apiKey && p.apiKey.trim()),
  };
}

export type PublicProvider = ReturnType<typeof toPublicProvider>;

export function providersToEngineConfig(providers: StoredProvider[]) {
  const enabled = providers.filter((p) => p.enabled);
  const mapOne = (p: StoredProvider, priority: number) => ({
    type: p.type,
    model: p.models[0] || undefined,
    endpoint: p.endpoint || undefined,
    priority,
    api_key: p.apiKey || undefined,
    rpm_limit: p.quota.rpm,
    daily_budget_usd: p.quota.dailyBudget,
    max_concurrent: p.quota.maxConcurrency,
    tpm_limit: p.quota.tpm,
    models: p.models,
    name: p.name,
  });

  const orchestrator = enabled.slice(0, 3).map((p, i) => mapOne(p, i + 1));
  const workers = enabled.map((p, i) => mapOne(p, i + 1));

  return {
    orchestrator: { providers: orchestrator },
    workers: { providers: workers },
    settings: {
      source: 'dashboard_settings',
      updated_at: new Date().toISOString(),
    },
  };
}
