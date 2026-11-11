import { NextRequest, NextResponse } from 'next/server';
import {
  loadProvidersStore,
  saveProvidersStore,
  toPublicProvider,
  providersToEngineConfig,
  type StoredProvider,
  type StoredProviderAllocation,
  type ProvidersStore,
  type PublicProvider,
} from '@/lib/providerStore';
import { engineFetch, ENGINE_BASE } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mergeEngineProviders(
  store: ProvidersStore,
  engineData: {
    orchestrator?: { providers?: Array<Record<string, unknown>> };
    workers?: { providers?: Array<Record<string, unknown>> };
  } | null,
): PublicProvider[] {
  const publicLocal = store.providers.map(toPublicProvider);
  if (!engineData) return publicLocal;

  const seen = new Set(publicLocal.map((p) => `${p.type}|${p.endpoint}|${p.models[0] || ''}`));
  const extras: PublicProvider[] = [];

  const ingest = (list: Array<Record<string, unknown>> | undefined, prefix: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((p, i) => {
      const type = String(p.type || 'custom');
      const endpoint = String(p.endpoint || '');
      const model = p.model ? String(p.model) : '';
      const key = `${type}|${endpoint}|${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      extras.push({
        id: `engine-${prefix}-${i}-${type}`,
        name: String(p.name || `${type} (${prefix})`),
        type,
        endpoint,
        models: model ? [model] : [],
        quota: {
          rpm: Number(p.rpm_limit || 30),
          tpm: Number(p.tpm_limit || 50000),
          dailyBudget: Number(p.daily_budget_usd || 0),
          maxConcurrency: Number(p.max_concurrent || 2),
        },
        enabled: true,
        hasApiKey: Boolean(p.has_api_key),
        apiKeySet: Boolean(p.has_api_key),
      });
    });
  };

  ingest(engineData.orchestrator?.providers, 'orch');
  ingest(engineData.workers?.providers, 'worker');
  return [...publicLocal, ...extras];
}

export async function GET() {
  const store = await loadProvidersStore();

  const engine = await engineFetch<{
    orchestrator?: { providers?: Array<Record<string, unknown>> };
    workers?: { providers?: Array<Record<string, unknown>> };
  }>('/api/decomposition/config/providers', { timeoutMs: 4000 });

  const llm = await engineFetch<Record<string, unknown>>('/llm/providers', { timeoutMs: 3000 });
  const health = await engineFetch<Record<string, unknown>>('/health', { timeoutMs: 3000 });

  return NextResponse.json({
    ok: true,
    engineUrl: ENGINE_BASE,
    engineOnline: engine.ok || health.ok,
    providers: mergeEngineProviders(store, engine.ok ? engine.data : null),
    allocations: store.allocations,
    roleBindings: store.roleBindings || [],
    updatedAt: store.updatedAt,
    engineConfig: engine.ok ? engine.data : null,
    engineError: engine.ok === false ? engine.error : undefined,
    llmProviders: llm.ok ? llm.data : null,
    health: health.ok ? health.data : null,
  });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = await loadProvidersStore();

    const incoming = Array.isArray(body.providers) ? body.providers : [];
    const nextProviders: StoredProvider[] = incoming.map(
      (p: Record<string, unknown>, i: number) => {
        const id = String(p.id || `p${Date.now()}-${i}`);
        const existing = current.providers.find((x) => x.id === id);
        const rawKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
        // Keep previous key unless client sent a new non-empty / non-masked value
        const keepKey =
          !rawKey || rawKey === '********' || rawKey.startsWith('••')
            ? existing?.apiKey
            : rawKey;

        return {
          id,
          name: String(p.name || 'Provider'),
          type: String(p.type || 'custom'),
          apiKey: keepKey,
          endpoint: String(p.endpoint || ''),
          models: Array.isArray(p.models)
            ? p.models.map(String).filter(Boolean)
            : String(p.models || '')
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean),
          quota: {
            rpm: Math.max(0, Number((p.quota as StoredProvider['quota'])?.rpm ?? 30)),
            tpm: Math.max(0, Number((p.quota as StoredProvider['quota'])?.tpm ?? 50000)),
            dailyBudget: Math.max(
              0,
              Number((p.quota as StoredProvider['quota'])?.dailyBudget ?? 0),
            ),
            maxConcurrency: Math.max(
              1,
              Number((p.quota as StoredProvider['quota'])?.maxConcurrency ?? 2),
            ),
          },
          enabled: p.enabled !== false,
          gpuRam: p.gpuRam as StoredProvider['gpuRam'],
        };
      },
    );

    const allocations: StoredProviderAllocation[] = Array.isArray(body.allocations)
      ? body.allocations
      : current.allocations;

    const roleBindings = Array.isArray(body.roleBindings)
      ? body.roleBindings
      : current.roleBindings || [];

    const store: ProvidersStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      providers: nextProviders,
      allocations,
      roleBindings,
    };
    await saveProvidersStore(store);

    let engineSynced = false;
    let engineError: string | undefined;
    let engineReloaded = false;

    if (body.syncEngine !== false) {
      const payload = providersToEngineConfig(nextProviders);
      const put = await engineFetch('/api/decomposition/config/providers', {
        method: 'PUT',
        body: JSON.stringify(payload),
        timeoutMs: 8000,
      });
      engineSynced = put.ok;
      if (put.ok === false) engineError = put.error;

      if (put.ok && body.reload !== false) {
        const reload = await engineFetch('/api/decomposition/config/providers/reload', {
          method: 'POST',
          timeoutMs: 5000,
        });
        engineReloaded = reload.ok;
      }
    }

    return NextResponse.json({
      ok: true,
      providers: store.providers.map(toPublicProvider),
      allocations: store.allocations,
      roleBindings: store.roleBindings || [],
      updatedAt: store.updatedAt,
      engineSynced,
      engineReloaded,
      engineError,
      engineUrl: ENGINE_BASE,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
