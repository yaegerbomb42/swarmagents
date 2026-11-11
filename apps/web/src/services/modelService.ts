import { inferenceApi } from './api';

function engineBase(): string {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_ENGINE_URL || '/api/engine';
  }
  return process.env.ENGINE_URL || 'http://localhost:8400';
}

export const modelService = {
  getModels: async (): Promise<Array<{ id: string; name: string; role: string }>> => {
    const base = engineBase();
    const res = await fetch(`${base}/status`, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      const models = data.models || {};
      return Object.entries(models).map(([id, cfg]) => {
        const c = cfg as { name?: string; role?: string };
        return {
          id,
          name: c.name || id,
          role: c.role || 'unknown',
        };
      });
    }

    const providers = await fetch(`${base}/llm/providers`, { cache: 'no-store' }).catch(() => null);
    if (providers?.ok) {
      const data = await providers.json();
      const list = data.providers || data.models || [];
      if (Array.isArray(list)) {
        return list.map((p: Record<string, unknown>, i: number) => ({
          id: String(p.id || p.name || i),
          name: String(p.name || p.id || `model-${i}`),
          role: String(p.role || 'provider'),
        }));
      }
    }

    const apiRes = await inferenceApi.listModels();
    if (apiRes.ok && apiRes.data.models) return apiRes.data.models;
    return [];
  },

  getModel: async (id: string) => {
    const models = await modelService.getModels();
    return models.find((m) => m.id === id) || null;
  },

  runInference: async (modelId: string, input: string) => {
    const base = engineBase();
    try {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input, model_preference: modelId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.response || data.success) {
          return { output: data.response || '' };
        }
      }
    } catch {
      /* fall through */
    }

    try {
      const apiRes = await inferenceApi.run([{ role: 'user', content: input }], {
        preferredModel: modelId,
      });
      if (apiRes.ok) {
        return { output: apiRes.data.result?.content || apiRes.data.result?.output || '' };
      }
    } catch {
      /* fall through */
    }

    return { output: '' };
  },
};
