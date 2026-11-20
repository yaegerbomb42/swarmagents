'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicProvider } from '@/lib/providerStore';

export interface PillBackend {
  /** Provider type in the store / templates. */
  type: string;
  label: string;
  /** Default model for this backend (template's first model). */
  model: string;
}

/**
 * The five backends the console offers. Nemotron runs on the NVIDIA NIM
 * preset; Mercury is the Inception Labs template (added next to the
 * NVIDIA entry in providerTemplates.ts).
 */
export const PILL_BACKENDS: PillBackend[] = [
  { type: 'nvidia', label: 'Nemotron', model: 'nvidia/llama-3.1-nemotron-70b-instruct' },
  { type: 'mercury', label: 'Mercury', model: 'mercury-3' },
  { type: 'gemini', label: 'Gemini', model: 'gemini-2.5-pro' },
  { type: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile' },
  { type: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-4.1' },
];

type ConfigResponse = {
  ok?: boolean;
  engineOnline?: boolean;
  providers?: PublicProvider[];
};

/**
 * Sleek selector pill for switching model backends.
 *
 * The real selection mechanism is the provider store's priority order:
 * providersToEngineConfig gives the first enabled provider priority 1, so
 * picking a backend reorders it to first via PUT /api/providers/config
 * (and the route syncs that order to the engine). A backend with no
 * configured provider — or one whose key is missing — shows as
 * unconfigured (with a +) and routes to Settings instead of pretending
 * it works.
 */
export function ProviderPill({
  selected,
  onSelect,
  onNeedSetup,
}: {
  /** Currently selected backend type, or null. */
  selected: string | null;
  onSelect: (backend: PillBackend) => void;
  onNeedSetup: (backend: PillBackend) => void;
}) {
  const [providers, setProviders] = useState<PublicProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const initialised = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/providers/config', { cache: 'no-store' });
      const data = (await res.json()) as ConfigResponse;
      setProviders(Array.isArray(data.providers) ? data.providers : []);
    } catch {
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // On first load, adopt the backend the store already has first (the
  // engine's priority-1 provider) so the pill reflects real state.
  useEffect(() => {
    if (initialised.current || !providers) return;
    initialised.current = true;
    if (selected) return;
    const active = providers.find((p) => p.enabled);
    const match = active ? PILL_BACKENDS.find((b) => b.type === active.type) : undefined;
    if (match) onSelect(match);
  }, [providers, selected, onSelect]);

  const pick = async (backend: PillBackend) => {
    if (busy) return;
    const list = providers ?? [];
    const existing = list.find((p) => p.type === backend.type);
    if (!existing) {
      onNeedSetup(backend);
      return;
    }
    if (!existing.hasApiKey) {
      onNeedSetup(backend);
      return;
    }
    if (selected === backend.type) {
      onSelect(backend);
      return;
    }
    // Reorder the LOCAL store only. Engine-merged providers (id
    // `engine-*`) are read-only reflections of the engine's own config —
    // sending them back in a PUT would persist duplicates locally.
    const localList = list.filter((p) => !p.id.startsWith('engine-'));
    const local = localList.find((p) => p.type === backend.type);
    if (!local) {
      // Backend exists only on the engine side: select it for this
      // console's dispatch; engine priority stays the engine's business.
      onSelect(backend);
      return;
    }
    setBusy(true);
    try {
      const reordered = [
        { ...local, enabled: true },
        ...localList.filter((p) => p.id !== local.id),
      ];
      const res = await fetch('/api/providers/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: reordered }),
      });
      if (res.ok) {
        const data = (await res.json()) as ConfigResponse;
        if (Array.isArray(data.providers)) setProviders(data.providers);
      }
      onSelect(backend);
    } catch {
      onSelect(backend);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-center" role="group" aria-label="Model backend">
      <div className="inline-flex items-center gap-0.5 rounded-full border border-line-2 bg-bg-1 p-0.5">
        {PILL_BACKENDS.map((backend) => {
          const configured = (providers ?? []).some(
            (p) => p.type === backend.type && p.hasApiKey,
          );
          const present = (providers ?? []).some((p) => p.type === backend.type);
          const active = selected === backend.type;
          return (
            <button
              key={backend.type}
              type="button"
              disabled={providers === null}
              onClick={() => void pick(backend)}
              title={
                configured
                  ? active
                    ? `${backend.label} · active (${backend.model})`
                    : `${backend.label} · click to switch (${backend.model})`
                  : present
                    ? `${backend.label} · no key set — click to add one in Settings`
                    : `${backend.label} · not configured — click to add in Settings`
              }
              className={`rounded-full px-3 py-1.5 text-meta font-medium transition-colors duration-fast ease-out ${
                active
                  ? 'bg-accent text-zinc-950'
                  : 'text-fg-3 hover:text-fg-1 hover:bg-white/[0.05]'
              } ${!configured ? 'opacity-70' : ''}`}
            >
              {backend.label}
              {!configured && <span className="ml-1 text-micro leading-none">+</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
