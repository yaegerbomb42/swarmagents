/**
 * Sandbox flyout drawer (Step 9.4): mounted workspace directories with RO/RW toggles,
 * environment variable masks, and outbound network isolation (airgap).
 *
 * State is managed with a pure reducer + dispatch (useReducer-style) so mount/env/airgap
 * transitions are explicit and renders are coalesced to avoid layout thrashing.
 */
import { escapeHtml } from './render.js';

export interface SandboxMount {
  path: string;
  mode: 'ro' | 'rw';
  /** Optional display label; defaults to path. */
  label?: string;
}

export interface SandboxEnvVar {
  name: string;
  /** True when the value is masked from the sandbox/process view. */
  masked: boolean;
  /** Optional masked preview (e.g. "sk-••••"); never the raw secret. */
  preview?: string;
}

export interface SandboxSettingsState {
  open: boolean;
  mounts: SandboxMount[];
  env: SandboxEnvVar[];
  airgap: boolean;
  /** Last status line shown in the drawer (info/error). */
  status: { text: string; tone: 'info' | 'ok' | 'error' } | null;
}

export type SandboxSettingsAction =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE_OPEN' }
  | { type: 'HYDRATE'; mounts: SandboxMount[]; env: SandboxEnvVar[]; airgap: boolean }
  | { type: 'SET_MOUNT_MODE'; path: string; mode: 'ro' | 'rw' }
  | { type: 'SET_ENV_MASKED'; name: string; masked: boolean }
  | { type: 'SET_AIRGAP'; enabled: boolean }
  | { type: 'STATUS'; text: string; tone: 'info' | 'ok' | 'error' }
  | { type: 'CLEAR_STATUS' };

export type Post = (msg: Record<string, unknown>) => void;

export function sandboxSettingsReducer(
  state: SandboxSettingsState,
  action: SandboxSettingsAction,
): SandboxSettingsState {
  switch (action.type) {
    case 'OPEN':
      return state.open ? state : { ...state, open: true };
    case 'CLOSE':
      return state.open ? { ...state, open: false, status: null } : state;
    case 'TOGGLE_OPEN':
      return { ...state, open: !state.open, status: state.open ? null : state.status };
    case 'HYDRATE':
      return {
        ...state,
        mounts: action.mounts,
        env: action.env,
        airgap: action.airgap,
      };
    case 'SET_MOUNT_MODE':
      return {
        ...state,
        mounts: state.mounts.map((m) => (m.path === action.path ? { ...m, mode: action.mode } : m)),
      };
    case 'SET_ENV_MASKED':
      return {
        ...state,
        env: state.env.map((v) => (v.name === action.name ? { ...v, masked: action.masked } : v)),
      };
    case 'SET_AIRGAP':
      return { ...state, airgap: action.enabled };
    case 'STATUS':
      return { ...state, status: { text: action.text, tone: action.tone } };
    case 'CLEAR_STATUS':
      return state.status ? { ...state, status: null } : state;
    default:
      return state;
  }
}

function initialState(): SandboxSettingsState {
  return { open: false, mounts: [], env: [], airgap: false, status: null };
}

let state: SandboxSettingsState = initialState();
let postRef: Post | undefined;
let renderQueued = false;
let wired = false;

function getEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function dispatch(action: SandboxSettingsAction): void {
  const next = sandboxSettingsReducer(state, action);
  if (next === state) return;
  state = next;
  scheduleRender();
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function renderMounts(): string {
  if (!state.mounts.length) {
    return '<p class="sb-empty">No mounted directories reported.</p>';
  }
  return `<ul class="sb-mount-list" role="list">${state.mounts
    .map((m) => {
      const ro = m.mode === 'ro';
      const rw = m.mode === 'rw';
      return `<li class="sb-mount" data-mount-path="${escapeHtml(m.path)}">
        <span class="sb-mount-path" title="${escapeHtml(m.path)}">${escapeHtml(m.label ?? m.path)}</span>
        <span class="sb-mode-toggle" role="group" aria-label="Mount mode for ${escapeHtml(m.path)}">
          <button type="button" data-mount-mode="ro" data-path="${escapeHtml(m.path)}" aria-pressed="${String(ro)}" title="Read-only">RO</button>
          <button type="button" data-mount-mode="rw" data-path="${escapeHtml(m.path)}" aria-pressed="${String(rw)}" title="Read-write">RW</button>
        </span>
      </li>`;
    })
    .join('')}</ul>`;
}

function renderEnv(): string {
  if (!state.env.length) {
    return '<p class="sb-empty">No environment variables reported.</p>';
  }
  return `<ul class="sb-env-list" role="list">${state.env
    .map((v) => {
      const preview = v.masked ? (v.preview ?? '••••••••') : '(visible to sandbox)';
      return `<li class="sb-env-row">
        <span class="sb-env-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
        <span class="sb-env-mask" aria-hidden="true">${escapeHtml(preview)}</span>
        <button type="button" class="sb-env-toggle${v.masked ? ' masked' : ''}" data-env-name="${escapeHtml(v.name)}" aria-pressed="${String(!v.masked)}" title="${v.masked ? 'Masked: click to unmask for sandbox' : 'Visible: click to mask'}">${v.masked ? 'Masked' : 'Visible'}</button>
      </li>`;
    })
    .join('')}</ul>`;
}

function renderAirgap(): string {
  const on = state.airgap;
  return `<div class="sb-airgap-row${on ? ' is-on' : ''}">
    <div class="sb-airgap-copy">
      <div class="sb-airgap-title">Outbound network isolation</div>
      <div class="sb-airgap-desc">${on ? 'Airgap mode is on. Outbound network access is blocked for the sandbox.' : 'When on, the sandbox cannot make outbound network requests.'}</div>
    </div>
    <button type="button" id="sb-airgap-switch" class="sb-switch" role="switch" aria-checked="${String(on)}" aria-label="Outbound network isolation (airgap mode)"></button>
  </div>`;
}

function render(): void {
  const drawer = getEl('sandbox-drawer');
  const backdrop = getEl('sandbox-drawer-backdrop');
  if (!drawer || !backdrop) return;

  drawer.hidden = !state.open;
  backdrop.hidden = !state.open;
  if (!state.open) return;

  const status = getEl('sb-settings-status');
  const mounts = getEl('sb-mounts');
  const env = getEl('sb-env');
  const airgap = getEl('sb-airgap');
  if (mounts) mounts.innerHTML = renderMounts();
  if (env) env.innerHTML = renderEnv();
  if (airgap) airgap.innerHTML = renderAirgap();
  if (status) {
    status.textContent = state.status?.text ?? '';
    status.className = `sb-status${state.status ? ` is-${state.status.tone}` : ''}`;
  }
}

function post(msg: Record<string, unknown>): void {
  postRef?.(msg);
}

export function openSandboxSettings(): void {
  dispatch({ type: 'OPEN' });
  post({ type: 'sandboxRequestState' });
}

export function closeSandboxSettings(): void {
  dispatch({ type: 'CLOSE' });
}

export function toggleSandboxSettings(): void {
  const wasOpen = state.open;
  dispatch({ type: 'TOGGLE_OPEN' });
  if (!wasOpen) post({ type: 'sandboxRequestState' });
}

/** Handle messages from the extension/server that belong to sandbox settings. */
export function onSandboxSettingsMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type === 'sandboxState') {
    const mounts = Array.isArray(m.mounts)
      ? (m.mounts as Record<string, unknown>[])
          .filter((x) => typeof x.path === 'string')
          .map((x) => ({
            path: x.path as string,
            mode: x.mode === 'rw' ? ('rw' as const) : ('ro' as const),
            ...(typeof x.label === 'string' ? { label: x.label } : {}),
          }))
      : state.mounts;
    const env = Array.isArray(m.env)
      ? (m.env as Record<string, unknown>[])
          .filter((x) => typeof x.name === 'string')
          .map((x) => ({
            name: x.name as string,
            masked: x.masked !== false,
            ...(typeof x.preview === 'string' ? { preview: x.preview } : {}),
          }))
      : state.env;
    const airgap = m.airgap === true;
    dispatch({ type: 'HYDRATE', mounts, env, airgap });
    // Let the scrubber consume checkpoint data from the same message if present.
    return false; // not exclusively consumed; chat.ts can fan out
  }
  if (m.type === 'sandboxError' && typeof m.message === 'string') {
    dispatch({ type: 'STATUS', text: m.message, tone: 'error' });
    return true;
  }
  return false;
}

export function wireSandboxSettings(postFn: Post): void {
  postRef = postFn;
  if (wired) return;
  wired = true;

  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    if (t.closest('#sb-settings-close') || t.closest('#sandbox-drawer-backdrop')) {
      closeSandboxSettings();
      return;
    }
    if (t.closest('[data-action="open-sandbox-settings"]') || t.closest('#sb-open-settings')) {
      toggleSandboxSettings();
      return;
    }

    const mountBtn = t.closest<HTMLElement>('[data-mount-mode]');
    if (mountBtn) {
      const path = mountBtn.dataset.path;
      const mode = mountBtn.dataset.mountMode === 'rw' ? 'rw' : 'ro';
      if (!path) return;
      dispatch({ type: 'SET_MOUNT_MODE', path, mode });
      post({ type: 'sandboxSetMount', path, mode });
      dispatch({
        type: 'STATUS',
        text: `Mount ${path} set to ${mode.toUpperCase()}.`,
        tone: 'info',
      });
      return;
    }

    const envBtn = t.closest<HTMLElement>('[data-env-name]');
    if (envBtn) {
      const name = envBtn.dataset.envName;
      if (!name) return;
      const current = state.env.find((v) => v.name === name);
      const masked = current ? !current.masked : true;
      dispatch({ type: 'SET_ENV_MASKED', name, masked });
      post({ type: 'sandboxSetEnvMask', name, masked });
      dispatch({
        type: 'STATUS',
        text: `${name} ${masked ? 'masked' : 'unmasked'} for sandbox.`,
        tone: 'info',
      });
      return;
    }

    if (t.closest('#sb-airgap-switch')) {
      const enabled = !state.airgap;
      dispatch({ type: 'SET_AIRGAP', enabled });
      post({ type: 'sandboxSetAirgap', enabled });
      dispatch({
        type: 'STATUS',
        text: enabled ? 'Airgap mode enabled.' : 'Airgap mode disabled.',
        tone: enabled ? 'ok' : 'info',
      });
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) {
      // Don't steal Escape from settings/inspector overlays if they are open.
      const settingsOpen = !document.getElementById('settings')?.hidden;
      const inspectorOpen = !document.getElementById('inspector')?.hidden;
      if (settingsOpen || inspectorOpen) return;
      closeSandboxSettings();
    }
  });
}

export function getSandboxSettingsState(): SandboxSettingsState {
  return state;
}
