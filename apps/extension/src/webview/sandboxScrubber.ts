/**
 * Sandbox checkpoint scrubber (Step 9.5): timeline bar (t_0 .. t_current) with
 * one-click "Rollback VM & Git State" triggering GitTreeSnapshotter and container
 * filesystem rollback over postMessage IPC.
 *
 * Uses a pure reducer + dispatch (useReducer-style) state machine to manage timeline
 * selection and rollback status without layout thrashing.
 */
import { formatClock } from './render.js';

export interface SandboxCheckpoint {
  id: string;
  /** 0-based timeline index; t_0 is the first checkpoint. */
  index: number;
  /** Human label (commit subject, step name, etc.). */
  label?: string;
  createdAt?: number;
  /** Optional git ref/snapshot id for display. */
  gitRef?: string;
}

export interface SandboxScrubberState {
  checkpoints: SandboxCheckpoint[];
  /** Index of the currently active/applied checkpoint (t_current). */
  currentIndex: number;
  /** Index selected on the scrubber (may differ while previewing). */
  selectedIndex: number;
  rollingBack: boolean;
  rollbackTargetId: string | null;
  status: { text: string; tone: 'info' | 'ok' | 'error' } | null;
}

export type SandboxScrubberAction =
  | { type: 'HYDRATE'; checkpoints: SandboxCheckpoint[]; currentCheckpointId?: string | null }
  | { type: 'SELECT'; index: number }
  | { type: 'ROLLBACK_START'; checkpointId: string }
  | {
      type: 'ROLLBACK_DONE';
      ok: boolean;
      checkpointId: string;
      error?: string;
      currentIndex?: number;
    }
  | { type: 'STATUS'; text: string; tone: 'info' | 'ok' | 'error' }
  | { type: 'CLEAR_STATUS' };

export type Post = (msg: Record<string, unknown>) => void;

export function sandboxScrubberReducer(
  state: SandboxScrubberState,
  action: SandboxScrubberAction,
): SandboxScrubberState {
  switch (action.type) {
    case 'HYDRATE': {
      const checkpoints = [...action.checkpoints].sort((a, b) => a.index - b.index);
      let currentIndex = checkpoints.length ? checkpoints.length - 1 : 0;
      if (action.currentCheckpointId) {
        const found = checkpoints.findIndex((c) => c.id === action.currentCheckpointId);
        if (found >= 0) currentIndex = found;
      }
      const selectedIndex = Math.min(
        Math.max(0, state.selectedIndex),
        Math.max(0, checkpoints.length - 1),
      );
      return {
        ...state,
        checkpoints,
        currentIndex,
        selectedIndex: checkpoints.length
          ? state.checkpoints.length
            ? selectedIndex
            : currentIndex
          : 0,
        rollingBack: false,
        rollbackTargetId: null,
      };
    }
    case 'SELECT': {
      const max = Math.max(0, state.checkpoints.length - 1);
      const index = Math.min(Math.max(0, action.index), max);
      return index === state.selectedIndex ? state : { ...state, selectedIndex: index };
    }
    case 'ROLLBACK_START':
      if (state.rollingBack) return state;
      return { ...state, rollingBack: true, rollbackTargetId: action.checkpointId, status: null };
    case 'ROLLBACK_DONE': {
      const failed = !action.ok;
      let currentIndex = state.currentIndex;
      if (action.ok) {
        if (typeof action.currentIndex === 'number') {
          currentIndex = action.currentIndex;
        } else {
          const idx = state.checkpoints.findIndex((c) => c.id === action.checkpointId);
          if (idx >= 0) currentIndex = idx;
        }
      }
      return {
        ...state,
        rollingBack: false,
        rollbackTargetId: null,
        currentIndex,
        selectedIndex: action.ok ? currentIndex : state.selectedIndex,
        status: {
          tone: failed ? 'error' : 'ok',
          text: failed
            ? (action.error ?? `Rollback to ${action.checkpointId} failed.`)
            : `Rolled back VM & Git state to t_${currentIndex}.`,
        },
      };
    }
    case 'STATUS':
      return { ...state, status: { text: action.text, tone: action.tone } };
    case 'CLEAR_STATUS':
      return state.status ? { ...state, status: null } : state;
    default:
      return state;
  }
}

function initialState(): SandboxScrubberState {
  return {
    checkpoints: [],
    currentIndex: 0,
    selectedIndex: 0,
    rollingBack: false,
    rollbackTargetId: null,
    status: null,
  };
}

let state: SandboxScrubberState = initialState();
let postRef: Post | undefined;
let renderQueued = false;
let wired = false;

function getEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function dispatch(action: SandboxScrubberAction): void {
  const next = sandboxScrubberReducer(state, action);
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

function post(msg: Record<string, unknown>): void {
  postRef?.(msg);
}

function selectedCheckpoint(): SandboxCheckpoint | undefined {
  return state.checkpoints[state.selectedIndex];
}

function render(): void {
  const bar = getEl('sandbox-scrubber');
  if (!bar) return;

  // Show the scrubber when we have any checkpoint data, or keep hidden if unused.
  // It can be explicitly shown by messages; default hidden until hydrated.
  if (state.checkpoints.length === 0) {
    // Keep it hidden but don't force-hide if host wants it visible; leave as-is.
  } else {
    bar.hidden = false;
  }

  const range = getEl('sb-range');
  const tag = getEl('sb-checkpoint-tag');
  const meta = getEl('sb-checkpoint-meta');
  const ticks = getEl('sb-ticks');
  const rollback = getEl('sb-rollback');
  const status = getEl('sb-scrub-status');

  const max = Math.max(0, state.checkpoints.length - 1);
  const sel = selectedCheckpoint();
  const atCurrent = state.selectedIndex === state.currentIndex;

  if (range instanceof HTMLInputElement) {
    range.min = '0';
    range.max = String(max);
    range.value = String(state.selectedIndex);
    range.step = '1';
    range.disabled = state.checkpoints.length === 0 || state.rollingBack;
    range.setAttribute('aria-valuemin', '0');
    range.setAttribute('aria-valuemax', String(max));
    range.setAttribute('aria-valuenow', String(state.selectedIndex));
    range.setAttribute('aria-valuetext', `t_${state.selectedIndex} of t_${max}`);
  }
  if (tag) tag.textContent = state.checkpoints.length ? `t_${state.selectedIndex}` : 't_0';
  if (meta) {
    if (!sel) {
      meta.textContent = state.checkpoints.length ? '' : 'No checkpoints';
    } else {
      const parts: string[] = [];
      if (sel.label) parts.push(sel.label);
      if (sel.gitRef) parts.push(sel.gitRef.slice(0, 12));
      if (sel.createdAt) parts.push(formatClock(Math.max(0, Date.now() - sel.createdAt)) + ' ago');
      if (state.selectedIndex === state.currentIndex) parts.push('current');
      meta.textContent = parts.join(' · ') || sel.id;
      meta.title = [sel.label, sel.gitRef, sel.id].filter(Boolean).join(' — ');
    }
  }
  if (ticks) {
    ticks.innerHTML =
      max <= 0 ? '<span>t_0</span><span>t_0</span>' : `<span>t_0</span><span>t_${max}</span>`;
  }
  if (rollback instanceof HTMLButtonElement) {
    const canRollback = Boolean(sel) && !state.rollingBack && state.checkpoints.length > 0;
    rollback.disabled = !canRollback;
    rollback.classList.toggle('is-rolling', state.rollingBack);
    rollback.textContent = state.rollingBack
      ? `Rolling back to t_${state.selectedIndex}…`
      : atCurrent
        ? 'Rollback VM & Git State'
        : `Rollback VM & Git State → t_${state.selectedIndex}`;
    rollback.title = atCurrent
      ? 'Re-apply the current checkpoint (GitTreeSnapshotter + container filesystem rollback).'
      : `Rollback VM and Git state to t_${state.selectedIndex} via GitTreeSnapshotter and container filesystem rollback.`;
  }
  if (status) {
    status.textContent = state.status?.text ?? '';
    status.className = `sb-status${state.status ? ` is-${state.status.tone}` : ''}`;
  }
}

function triggerRollback(): void {
  const cp = selectedCheckpoint();
  if (!cp || state.rollingBack) return;
  dispatch({ type: 'ROLLBACK_START', checkpointId: cp.id });
  // IPC: host triggers GitTreeSnapshotter + container filesystem rollback.
  post({ type: 'sandboxRollback', checkpointId: cp.id, index: cp.index });
}

/** Handle messages from the extension/server that belong to the scrubber. */
export function onSandboxScrubberMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type === 'sandboxState') {
    const checkpoints = Array.isArray(m.checkpoints)
      ? (m.checkpoints as Record<string, unknown>[])
          .filter((x) => typeof x.id === 'string')
          .map((x, i) => ({
            id: x.id as string,
            index: typeof x.index === 'number' ? x.index : i,
            ...(typeof x.label === 'string' ? { label: x.label } : {}),
            ...(typeof x.createdAt === 'number' ? { createdAt: x.createdAt } : {}),
            ...(typeof x.gitRef === 'string' ? { gitRef: x.gitRef } : {}),
          }))
      : null;
    if (checkpoints) {
      dispatch({
        type: 'HYDRATE',
        checkpoints,
        currentCheckpointId:
          typeof m.currentCheckpointId === 'string' ? m.currentCheckpointId : null,
      });
    }
    return false; // fan-out (settings may also consume)
  }
  if (m.type === 'sandboxCheckpoints' && Array.isArray(m.checkpoints)) {
    const checkpoints = (m.checkpoints as Record<string, unknown>[])
      .filter((x) => typeof x.id === 'string')
      .map((x, i) => ({
        id: x.id as string,
        index: typeof x.index === 'number' ? x.index : i,
        ...(typeof x.label === 'string' ? { label: x.label } : {}),
        ...(typeof x.createdAt === 'number' ? { createdAt: x.createdAt } : {}),
        ...(typeof x.gitRef === 'string' ? { gitRef: x.gitRef } : {}),
      }));
    dispatch({
      type: 'HYDRATE',
      checkpoints,
      currentCheckpointId: typeof m.currentCheckpointId === 'string' ? m.currentCheckpointId : null,
    });
    return true;
  }
  if (m.type === 'sandboxRollbackResult') {
    dispatch({
      type: 'ROLLBACK_DONE',
      ok: m.ok === true,
      checkpointId: typeof m.checkpointId === 'string' ? m.checkpointId : '',
      ...(typeof m.error === 'string' ? { error: m.error } : {}),
      ...(typeof m.currentIndex === 'number' ? { currentIndex: m.currentIndex } : {}),
    });
    return true;
  }
  return false;
}

export function wireSandboxScrubber(postFn: Post): void {
  postRef = postFn;
  if (wired) return;
  wired = true;

  const range = getEl('sb-range');
  if (range instanceof HTMLInputElement) {
    range.addEventListener('input', () => {
      dispatch({ type: 'SELECT', index: Number(range.value) });
    });
    range.addEventListener('change', () => {
      dispatch({ type: 'SELECT', index: Number(range.value) });
    });
  }

  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('#sb-rollback')) triggerRollback();
  });
}

export function showSandboxScrubber(): void {
  const bar = getEl('sandbox-scrubber');
  if (bar) bar.hidden = false;
}

export function getSandboxScrubberState(): SandboxScrubberState {
  return state;
}
