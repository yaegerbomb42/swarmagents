/**
 * Context Inspector HUD (Step 9.6): renders active token counts, KV-cache hit
 * ratios, and active tools. Pure state hydration + data binding functions are
 * exported for unit tests; DOM helpers are used by the webview.
 */
import { escapeHtml, formatTokens } from './render.js';

export interface ContextTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Active/context-window tokens currently in use (if known). */
  active: number | null;
  /** Context window/budget limit (if known). */
  limit: number | null;
}

export interface ContextInspectorActiveTool {
  name: string;
  kind?: string;
  /** Optional human-readable status/detail (e.g. file path, command). */
  detail?: string;
}

export interface ContextInspectorState {
  tokens: ContextTokenCounts;
  /** KV-cache hit ratio as 0..1 (NaN/invalid inputs become 0). */
  kvCacheHitRatio: number;
  /** Hit ratio as 0..100 integer percent for display. */
  kvCacheHitPercent: number;
  activeTools: ContextInspectorActiveTool[];
  /** True when any meaningful context data is present. */
  hasData: boolean;
}

export interface ContextInspectorHudModel {
  activeTokensLabel: string;
  tokenBreakdownLabel: string;
  kvCacheLabel: string;
  kvCachePercent: number;
  activeToolsLabel: string;
  activeTools: { name: string; kind: string; detail: string }[];
  hasData: boolean;
  tone: '' | 'warm' | 'hot';
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function percentUsed(used: number | null, limit: number | null): number {
  if (used === null || limit === null || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function toneForPercent(pct: number): '' | 'warm' | 'hot' {
  return pct > 90 ? 'hot' : pct >= 70 ? 'warm' : '';
}

function normalizeTool(raw: unknown): ContextInspectorActiveTool | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name =
    typeof obj.name === 'string'
      ? obj.name
      : typeof obj.tool === 'string'
        ? obj.tool
        : typeof obj.id === 'string'
          ? obj.id
          : '';
  if (!name.trim()) return null;
  const out: ContextInspectorActiveTool = { name: name.trim() };
  if (typeof obj.kind === 'string' && obj.kind) out.kind = obj.kind;
  if (typeof obj.detail === 'string' && obj.detail) out.detail = obj.detail;
  if (typeof obj.status === 'string' && obj.status && !out.detail) out.detail = obj.status;
  return out;
}

/**
 * Hydrate/normalize a raw context/usage snapshot into a stable inspector state.
 * Accepts partial chat-state-like payloads (`usage.tokens`, `context`, `activeTools`, etc.).
 */
export function hydrateContextInspector(raw: unknown): ContextInspectorState {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const usage =
    src.usage && typeof src.usage === 'object' ? (src.usage as Record<string, unknown>) : src;
  const tokensSrc =
    usage.tokens && typeof usage.tokens === 'object'
      ? (usage.tokens as Record<string, unknown>)
      : src.tokens && typeof src.tokens === 'object'
        ? (src.tokens as Record<string, unknown>)
        : {};

  const input = Math.max(0, Math.round(num(tokensSrc.input, num(src.inputTokens))));
  const output = Math.max(0, Math.round(num(tokensSrc.output, num(src.outputTokens))));
  const cacheRead = Math.max(0, Math.round(num(tokensSrc.cacheRead, num(src.cacheRead))));
  const cacheWrite = Math.max(0, Math.round(num(tokensSrc.cacheWrite, num(src.cacheWrite))));
  const total = Math.max(0, Math.round(num(src.totalTokens, input + output)));

  const context =
    src.context && typeof src.context === 'object'
      ? (src.context as Record<string, unknown>)
      : null;
  const activeRaw = context ? context.used : (src.activeTokens ?? src.contextUsed);
  const limitRaw = context ? context.limit : (src.contextLimit ?? src.limit);
  const active =
    typeof activeRaw === 'number' && Number.isFinite(activeRaw)
      ? Math.max(0, Math.round(activeRaw))
      : null;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.round(limitRaw)
      : null;

  const rawRatio =
    typeof src.kvCacheHitRatio === 'number'
      ? src.kvCacheHitRatio
      : typeof src.cacheHitRatio === 'number'
        ? src.cacheHitRatio
        : input > 0
          ? cacheRead / input
          : 0;
  const kvCacheHitRatio = clamp01(rawRatio);
  const kvCacheHitPercent = Math.round(kvCacheHitRatio * 100);

  const toolsRaw = Array.isArray(src.activeTools)
    ? src.activeTools
    : Array.isArray(src.tools)
      ? src.tools
      : [];
  const activeTools = toolsRaw
    .map(normalizeTool)
    .filter((t): t is ContextInspectorActiveTool => t !== null);

  const tokens: ContextTokenCounts = { input, output, cacheRead, cacheWrite, total, active, limit };
  const hasData =
    total > 0 || active !== null || activeTools.length > 0 || cacheRead > 0 || cacheWrite > 0;

  return { tokens, kvCacheHitRatio, kvCacheHitPercent, activeTools, hasData };
}

/** Bind hydrated inspector state to a render-ready HUD model (data binding). */
export function bindContextInspectorHud(
  state: ContextInspectorState,
  previous?: ContextInspectorState,
): ContextInspectorHudModel {
  const stable = state.hasData ? state : previous?.hasData ? previous : state;
  const pct = percentUsed(stable.tokens.active, stable.tokens.limit);
  const activeTokensLabel =
    stable.tokens.active !== null && stable.tokens.limit !== null
      ? `${formatTokens(stable.tokens.active)} / ${formatTokens(stable.tokens.limit)}`
      : stable.tokens.active !== null
        ? formatTokens(stable.tokens.active)
        : stable.tokens.total > 0
          ? formatTokens(stable.tokens.total)
          : '—';

  return {
    activeTokensLabel,
    tokenBreakdownLabel: `in ${formatTokens(stable.tokens.input)} · out ${formatTokens(stable.tokens.output)} · cache r ${formatTokens(stable.tokens.cacheRead)} · w ${formatTokens(stable.tokens.cacheWrite)}`,
    kvCacheLabel: `${String(stable.kvCacheHitPercent)}%`,
    kvCachePercent: stable.kvCacheHitPercent,
    activeToolsLabel: stable.activeTools.length ? String(stable.activeTools.length) : '0',
    activeTools: stable.activeTools.map((t) => ({
      name: t.name,
      kind: t.kind ?? 'tool',
      detail: t.detail ?? '',
    })),
    hasData: stable.hasData,
    tone: toneForPercent(pct),
  };
}

/** Render the HUD as HTML. Pure: safe for unit tests and DOM insertion. */
export function renderContextInspectorHud(state: ContextInspectorState): string {
  const model = bindContextInspectorHud(state);
  if (!model.hasData) {
    return `<section class="ctx-hud" data-ctx-hud aria-label="Context inspector HUD">
  <div class="ctx-hud-head"><span class="ctx-hud-title">Context HUD</span><span class="ctx-hud-sub">waiting for context</span></div>
</section>`;
  }
  const tools = model.activeTools.length
    ? `<ul class="ctx-hud-tools">${model.activeTools
        .map(
          (t) =>
            `<li class="ctx-hud-tool"><span class="ctx-hud-tool-kind">${escapeHtml(t.kind)}</span><span class="ctx-hud-tool-name">${escapeHtml(t.name)}</span>${t.detail ? `<span class="ctx-hud-tool-detail">${escapeHtml(t.detail)}</span>` : ''}</li>`,
        )
        .join('')}</ul>`
    : '<p class="ctx-hud-empty">No active tools</p>';

  return `<section class="ctx-hud${model.tone ? ` ${model.tone}` : ''}" data-ctx-hud aria-label="Context inspector HUD">
  <div class="ctx-hud-head">
    <span class="ctx-hud-title">Context HUD</span>
    <span class="ctx-hud-sub">active context · KV cache · tools</span>
  </div>
  <div class="ctx-hud-grid">
    <div class="ctx-hud-metric"><span class="k">Active tokens</span><span class="v">${escapeHtml(model.activeTokensLabel)}</span><span class="s">${escapeHtml(model.tokenBreakdownLabel)}</span></div>
    <div class="ctx-hud-metric"><span class="k">KV-cache hit</span><span class="v">${escapeHtml(model.kvCacheLabel)}</span><span class="ctx-hud-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(model.kvCachePercent)}"><span style="width:${String(model.kvCachePercent)}%"></span></span></div>
    <div class="ctx-hud-metric ctx-hud-metric-tools"><span class="k">Active tools</span><span class="v">${escapeHtml(model.activeToolsLabel)}</span>${tools}</div>
  </div>
</section>`;
}

/** DOM data binding: hydrate raw input and paint into the target element if changed. */
export function updateContextInspectorHud(targetId: string, raw: unknown): ContextInspectorState {
  const state = hydrateContextInspector(raw);
  const doc = (
    globalThis as unknown as {
      document?: { getElementById: (id: string) => { innerHTML: string } | null };
    }
  ).document;
  const el = doc ? doc.getElementById(targetId) : null;
  if (el) {
    const html = renderContextInspectorHud(state);
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  return state;
}
