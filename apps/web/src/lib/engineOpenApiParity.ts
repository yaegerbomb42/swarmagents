/**
 * OpenAPI parity contract — engine routes the dashboard must reach via /api/engine proxy.
 */

export type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
  info?: { title?: string; version?: string };
};

/** Routes that must appear in the engine OpenAPI spec (mounted on decomposition_server). */
export const CRITICAL_ENGINE_PATHS = [
  '/api/desktop-llm/status',
  '/api/desktop-llm/models',
  '/api/modal-apps/registry',
  '/api/modal-apps/health',
  '/api/benchmark/test-consensus',
  '/api/quantum/models/presets',
  '/api/quantum/router/metrics',
  '/api/quantum/router/metrics/providers',
  '/api/memory/active-goal',
  '/api/memory/episodic',
  '/llm/failover',
  '/tribal/rules',
  '/health',
] as const;

export type ParityAuditResult = {
  engineTitle: string;
  engineVersion: string;
  totalOpenApiPaths: number;
  criticalTotal: number;
  registered: string[];
  missing: string[];
  coveragePct: number;
  dashboardProxy: 'catch-all' | 'explicit';
};

export function auditEngineOpenApi(spec: OpenApiSpec | null | undefined): ParityAuditResult {
  const paths = spec?.paths ?? {};
  const openApiPaths = new Set(Object.keys(paths));
  const registered: string[] = [];
  const missing: string[] = [];

  for (const p of CRITICAL_ENGINE_PATHS) {
    if (openApiPaths.has(p)) registered.push(p);
    else missing.push(p);
  }

  const criticalTotal: number = CRITICAL_ENGINE_PATHS.length;
  const coveragePct =
    criticalTotal === 0 ? 100 : Math.round((registered.length / criticalTotal) * 100);

  return {
    engineTitle: spec?.info?.title ?? 'unknown',
    engineVersion: spec?.info?.version ?? '0',
    totalOpenApiPaths: openApiPaths.size,
    criticalTotal,
    registered,
    missing,
    coveragePct,
    dashboardProxy: 'catch-all',
  };
}

/** Fetch OpenAPI spec through the dashboard universal engine proxy. */
export async function fetchEngineOpenApiSpec(): Promise<OpenApiSpec> {
  const res = await fetch('/api/engine/openapi.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`engine openapi fetch failed: ${res.status}`);
  }
  return (await res.json()) as OpenApiSpec;
}

export function engineProxyUrl(enginePath: string): string {
  const normalized = enginePath.startsWith('/') ? enginePath : `/${enginePath}`;
  return `/api/engine${normalized}`;
}
