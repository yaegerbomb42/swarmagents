import { describe, it, expect } from 'vitest';
import {
  auditEngineOpenApi,
  CRITICAL_ENGINE_PATHS,
  engineProxyUrl,
} from '@/lib/engineOpenApiParity';

describe('engineOpenApiParity', () => {
  it('audits critical path coverage', () => {
    const spec = {
      info: { title: 'SwarmAgents Engine', version: '1.0' },
      paths: Object.fromEntries(CRITICAL_ENGINE_PATHS.map((p) => [p, { get: {} }])),
    };
    const audit = auditEngineOpenApi(spec);
    expect(audit.coveragePct).toBe(100);
    expect(audit.missing).toHaveLength(0);
    expect(audit.registered).toHaveLength(CRITICAL_ENGINE_PATHS.length);
  });

  it('reports missing routes', () => {
    const audit = auditEngineOpenApi({ paths: { '/health': { get: {} } } });
    expect(audit.missing.length).toBeGreaterThan(0);
    expect(audit.coveragePct).toBeLessThan(100);
  });

  it('builds engine proxy URLs', () => {
    expect(engineProxyUrl('/api/desktop-llm/status')).toBe('/api/engine/api/desktop-llm/status');
  });
});
