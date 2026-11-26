// Which provider + model is actually serving a run (core-34).
//
// Derived from the run stream: `run.started` carries the requested
// provider/model, and the run pool's `provider.pool` events (published as
// `{ type: "provider.pool", data: RunPoolEvent }`) report every attempt, so a
// mid-run failover or model-family switch shows up as soon as it happens.

import type { RunStreamItem } from "./useRunStream";

export interface ServingModelState {
  provider?: string;
  model?: string;
  /** True once any attempt was a failover or family switch. */
  failover: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The RunPoolEvent inside a `provider.pool` stream item (flattened or wrapped). */
export function poolEventOf(item: RunStreamItem): Record<string, unknown> | undefined {
  if (item.kind !== "provider.pool" || !isRecord(item.data)) return undefined;
  return isRecord(item.data.data) ? item.data.data : item.data;
}

export function reduceServingModel(items: readonly RunStreamItem[]): ServingModelState {
  const state: ServingModelState = { failover: false };
  for (const item of items) {
    if (!item || !isRecord(item.data)) continue;
    if (item.kind === "run.started") {
      // The pool's first attempt may already have named the real model; only
      // fill what is still unknown so an alias in init does not overwrite it.
      state.provider ??= str(item.data.provider);
      state.model ??= str(item.data.model);
      continue;
    }
    const ev = poolEventOf(item);
    if (!ev) continue;
    if (ev.type === "pool.attempt") {
      state.provider = str(ev.provider) ?? state.provider;
      state.model = str(ev.model) ?? state.model;
      if (ev.reason === "failover" || ev.reason === "family-switch") state.failover = true;
    } else if (ev.type === "pool.family") {
      state.model = str(ev.model) ?? state.model;
      state.failover = true;
    }
  }
  return state;
}

/** "groq · llama-3.3-70b", or "→ openrouter · deepseek-v3 (failover)". */
export function formatServingModel(state: ServingModelState): string | undefined {
  const base = [state.provider, state.model].filter(Boolean).join(" · ");
  if (!base) return undefined;
  return state.failover ? `→ ${base} (failover)` : base;
}
