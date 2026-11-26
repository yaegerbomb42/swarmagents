import type { RunStreamItem } from "./useRunStream";

export interface ServingModel {
  provider?: string;
  model?: string;
  failover?: boolean;
  switched?: boolean;
  reason?: string;
}

export interface ServingModelState {
  provider?: string;
  model?: string;
  failover: boolean;
  switched: boolean;
  reason?: string;
  previousProvider?: string;
  previousModel?: string;
  current: ServingModel;
  history: ServingModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function emptyState(): ServingModelState {
  return {
    failover: false,
    switched: false,
    current: {},
    history: [],
  };
}

function cloneState(state: ServingModelState): ServingModelState {
  return {
    ...state,
    current: { ...state.current },
    history: state.history.map((h) => ({ ...h })),
  };
}

function pushHistory(state: ServingModelState, entry: ServingModel): void {
  const last = state.history[state.history.length - 1];
  if (last && last.provider === entry.provider && last.model === entry.model && last.failover === entry.failover) {
    // avoid duplicate consecutive entries
  } else {
    state.history.push({ ...entry });
  }
}

function applyItem(state: ServingModelState, item: RunStreamItem): ServingModelState {
  const next = cloneState(state);
  const data = isRecord(item.data) ? item.data : {};

  if (item.kind === "run.started") {
    const provider = asString(data.provider);
    const model = asString(data.model);
    if (provider !== undefined || model !== undefined) {
      if (next.provider !== provider || next.model !== model) {
        next.previousProvider = next.provider;
        next.previousModel = next.model;
      }
      next.provider = provider ?? next.provider;
      next.model = model ?? next.model;
      next.current = { provider: next.provider, model: next.model, failover: next.failover, switched: next.switched, reason: next.reason };
      pushHistory(next, next.current);
    }
    return next;
  }

  if (item.kind === "run.mode") {
    const provider = asString(data.provider);
    const model = asString(data.model);
    if (provider !== undefined || model !== undefined) {
      if (provider !== undefined) next.provider = provider;
      if (model !== undefined) next.model = model;
      next.current = { provider: next.provider, model: next.model, failover: next.failover, switched: next.switched, reason: next.reason };
    }
    return next;
  }

  if (item.kind === "provider.pool") {
    // The bus wraps the RunPoolEvent under `data`; flatten one level if needed.
    const inner = isRecord(data.data) ? (data.data as Record<string, unknown>) : data;
    const innerType = asString(inner.type);

    if (innerType === "pool.attempt") {
      const provider = asString(inner.provider);
      const model = asString(inner.model);
      const reason = asString(inner.reason);
      const isFailover = reason === "failover" || reason === "family-switch";
      if (provider !== undefined || model !== undefined) {
        if ((provider !== undefined && provider !== next.provider) || (model !== undefined && model !== next.model)) {
          next.previousProvider = next.provider;
          next.previousModel = next.model;
        }
        if (provider !== undefined) next.provider = provider;
        if (model !== undefined) next.model = model;
      }
      if (reason !== undefined) next.reason = reason;
      if (isFailover) {
        next.failover = true;
        next.switched = reason === "family-switch" ? true : next.switched;
      }
      next.current = { provider: next.provider, model: next.model, failover: next.failover, switched: next.switched, reason: next.reason };
      pushHistory(next, next.current);
      return next;
    }

    if (innerType === "pool.failover") {
      next.failover = true;
      const provider = asString(inner.provider);
      if (provider !== undefined) next.previousProvider = provider;
      next.current = { provider: next.provider, model: next.model, failover: next.failover, switched: next.switched, reason: next.reason };
      return next;
    }

    if (innerType === "pool.family") {
      const model = asString(inner.model);
      const to = asString(inner.to);
      if (model !== undefined) next.model = model;
      next.switched = true;
      next.failover = true;
      if (to !== undefined) next.reason = `family:${to}`;
      next.current = { provider: next.provider, model: next.model, failover: next.failover, switched: next.switched, reason: next.reason };
      pushHistory(next, next.current);
      return next;
    }

    return next;
  }

  return next;
}

export function reduceServingModel(items: readonly RunStreamItem[] | unknown): ServingModelState {
  const list = Array.isArray(items) ? items : [];
  let state = emptyState();
  for (const item of list as RunStreamItem[]) {
    if (!item || typeof item !== "object") continue;
    state = applyItem(state, item as RunStreamItem);
  }
  // sync top-level fields
  state.provider = state.current.provider ?? state.provider;
  state.model = state.current.model ?? state.model;
  state.failover = state.current.failover ?? state.failover;
  state.switched = state.current.switched ?? state.switched;
  state.reason = state.current.reason ?? state.reason;
  return state;
}

export function applyServingModelEvent(state: ServingModelState, item: RunStreamItem): ServingModelState {
  const base = state && typeof state === "object" ? state : emptyState();
  return applyItem(base as ServingModelState, item);
}

export const servingModelReducer = applyServingModelEvent;

export function formatServingModel(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return input.trim() || undefined;
  const rec = input as Record<string, unknown>;
  const current = isRecord(rec.current) ? (rec.current as Record<string, unknown>) : undefined;
  const provider = asString(rec.provider) ?? (current ? asString(current.provider) : undefined);
  const model = asString(rec.model) ?? (current ? asString(current.model) : undefined);
  const failover =
    rec.failover === true || (current ? current.failover === true : false) || rec.switched === true || (current ? current.switched === true : false);
  if (!provider && !model) return undefined;
  const base = [provider, model].filter(Boolean).join(" · ");
  if (failover) return `→ ${base} (failover)`;
  return base;
}

// Aliases for discoverability.
export const deriveServingModel = reduceServingModel;
export const getServingModel = reduceServingModel;
export const servingModelFromItems = reduceServingModel;

export default reduceServingModel;
