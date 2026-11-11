/**
 * Terminal pills in the chat webview (Phase 9, roadmap 9.2): the pill DOM and
 * its xterm lifecycle. The host (terminal-pill.ts) derives pills from the
 * transcript and posts pillStart / pillOutput / pillEnd; this module owns the
 * per-pill state (buffer, status, xterm instance) and attaches it to the pill
 * shells render.ts emits inside tool clusters.
 *
 * Semantics:
 * - A pill is EXPANDED while its tool runs (unless the person closed it) and
 *   collapsible afterwards (closed unless they opened it) — the open state is
 *   decided at render time in chat.ts from the disclosure sets, like the other
 *   accordions.
 * - The xterm instance is created LAZILY, only when its pill is open: from
 *   window.Xterm (out/xterm.js, loaded after out/chat.js — accessed at expand
 *   time, never at import time), with FitAddon fitting it to the container
 *   width. Output arriving before expansion is buffered and replayed on first
 *   expand. Collapsing disposes the terminal (a fresh one replays the buffer
 *   on re-expand); a block re-render destroys the terminal's DOM, and syncPills
 *   notices the detached container and recreates it.
 * - Output-only: the terminal is created with stdin disabled — the chat server
 *   owns the tool process and there is no input channel back to it.
 * - If window.Xterm is absent, output renders into a <pre> with ANSI escapes
 *   stripped (same fallback shape as media/terminal.js, simpler: the pill
 *   content is transcript text, not raw PTY output).
 * - Per-pill output is bounded (MAX_PILL_BUFFER_CHARS, tail kept); both the
 *   xterm and the fallback read from the one buffer.
 * - Pills are keyed by entry id, which equals the block id (one act entry is
 *   one Block). Ended pills whose shells left the DOM (history cap) are pruned;
 *   running pills are always kept, since their shell may render later.
 */
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { escapeHtml, formatElapsedMs, type PillStatus, type TermPillView } from './render.js';

interface XtermBundle {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

interface PillRuntime {
  id: number;
  cmd: string;
  status: PillStatus;
  startedAt: number;
  endedMs?: number | undefined;
  exitCode?: number | null | undefined;
  buffer: string;
  term?: Terminal | undefined;
  fit?: FitAddon | undefined;
  container?: HTMLElement | undefined;
  fallbackPre?: HTMLPreElement | undefined;
}

/** Per-pill output retained for replay; tail kept past the cap. */
const MAX_PILL_BUFFER_CHARS = 200_000;
/** Fallback <pre> text cap; the full buffer stays in memory for xterm replay. */
const MAX_FALLBACK_CHARS = 8_000;

const pills = new Map<number, PillRuntime>();

function xtermBundle(): XtermBundle | undefined {
  const w = window as unknown as { Xterm?: XtermBundle };
  return w.Xterm;
}

function themeForeground(): string {
  const value = getComputedStyle(document.body)
    .getPropertyValue('--vscode-terminal-foreground')
    .trim();
  return value || '#cccccc';
}

/** The pill's live state for the header render, if the host has posted for it. */
export function getPillView(id: number): TermPillView | undefined {
  const p = pills.get(id);
  if (!p) return undefined;
  return {
    status: p.status,
    startedAt: p.startedAt,
    ...(p.endedMs !== undefined ? { endedMs: p.endedMs } : {}),
    ...(p.exitCode !== undefined ? { exitCode: p.exitCode } : {}),
  };
}

/** Output buffer for copy actions (bounded tail). */
export function getPillBuffer(id: number): string {
  return pills.get(id)?.buffer ?? '';
}

export function handlePillStart(id: number, cmd: string): void {
  const existing = pills.get(id);
  if (existing) {
    existing.cmd = cmd;
    existing.status = 'running';
    existing.startedAt = Date.now();
    existing.endedMs = undefined;
    return;
  }
  pills.set(id, {
    id,
    cmd,
    status: 'running',
    startedAt: Date.now(),
    buffer: '',
  });
}

export function handlePillOutput(id: number, chunk: string): void {
  let p = pills.get(id);
  if (!p) {
    p = { id, cmd: '', status: 'running', startedAt: Date.now(), buffer: '' };
    pills.set(id, p);
  }
  p.buffer = (p.buffer + chunk).slice(-MAX_PILL_BUFFER_CHARS);
  if (p.term) p.term.write(chunk);
  else if (p.fallbackPre) refreshFallback(p);
}

export function handlePillEnd(
  id: number,
  status: PillStatus,
  elapsedMs: number,
  exitCode?: number | null,
): void {
  const p = pills.get(id);
  if (!p) return;
  p.status = status;
  p.endedMs = Math.max(0, Math.floor(elapsedMs));
  if (exitCode !== undefined) p.exitCode = exitCode;
  updateHeader(p);
}

/** Dispose every terminal and forget every pill (fresh panel / new session). */
export function resetPills(): void {
  for (const p of pills.values()) disposeTerm(p);
  pills.clear();
}

/**
 * Reconcile pill state with the shells in the DOM; call after every
 * drawConversation. Creates terminals for open pills, disposes them for
 * closed or unmounted ones, and prunes ended pills whose blocks are gone.
 */
export function syncPills(): void {
  const shells = document.querySelectorAll<HTMLElement>('.term-pill[data-pill-id]');
  const seen = new Set<number>();
  for (const shell of shells) {
    const id = Number(shell.dataset.pillId);
    if (!Number.isFinite(id)) continue;
    seen.add(id);
    let p = pills.get(id);
    p ??= ensureDefaultPill(shell, id);
    if (p.term && p.container?.isConnected !== true) disposeTerm(p);
    if (p.fallbackPre?.isConnected === false) p.fallbackPre = undefined;
    const details = shell.querySelector<HTMLDetailsElement>('.term-pill-fold');
    const open = details?.open === true;
    if (open) {
      ensureTerm(p, shell);
      if (p.term && p.fit) fitTerm(p);
    } else if (p.term) {
      disposeTerm(p);
    }
  }
  for (const [id, p] of pills) {
    if (p.status !== 'running' && !seen.has(id)) {
      disposeTerm(p);
      pills.delete(id);
    }
  }
}

/**
 * A shell with no host state (a resumed transcript whose pill messages were
 * never posted, or a render that raced ahead of them): treat the tool as
 * finished, seed the buffer with its command echo, and let the header render
 * from the default (success, no elapsed time).
 */
function ensureDefaultPill(shell: HTMLElement, id: number): PillRuntime {
  const code = shell.querySelector('.term-pill-cmd code')?.textContent ?? '';
  const cmdText = shell.querySelector('.term-pill-cmd')?.textContent ?? '';
  const cmd = code || cmdText.replace(/^▶\s*bash:\s*/, '').trim();
  const startedRaw = shell.querySelector('.tool-elapsed')?.getAttribute('data-started-at');
  const startedAt = startedRaw !== null ? Number(startedRaw) : NaN;
  const p: PillRuntime = {
    id,
    cmd,
    status: 'success',
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    buffer: code ? `$ ${cmd}\n` : `${cmd}\n`,
  };
  pills.set(id, p);
  return p;
}

/** The pill header in place (status pill + final elapsed); the block need not re-render. */
function updateHeader(p: PillRuntime): void {
  const shell = document.querySelector(`.term-pill[data-pill-id="${String(p.id)}"]`);
  if (!shell) return;
  const statusEl = shell.querySelector<HTMLElement>('.term-pill-status');
  const elapsedLabel = p.endedMs !== undefined ? formatElapsedMs(p.endedMs) : '';
  if (statusEl) {
    statusEl.className = `term-pill-status is-${p.status}`;
    if (p.status === 'running') {
      statusEl.innerHTML = '<span class="pill-spin" aria-hidden="true"></span>Running';
      statusEl.title = 'Running';
    } else if (p.status === 'error') {
      const code = typeof p.exitCode === 'number' ? ` <span class="pill-exit">exit ${String(p.exitCode)}</span>` : '';
      statusEl.innerHTML = `<span class="pill-badge-icon" aria-hidden="true">!</span><span>Failed</span>${code}`;
      statusEl.title = typeof p.exitCode === 'number' ? `Failed (exit ${String(p.exitCode)})` : 'Failed';
    } else {
      statusEl.innerHTML = `<span class="pill-badge-icon" aria-hidden="true">✓</span>${elapsedLabel ? `<span class="pill-elapsed">${escapeHtml(elapsedLabel)}</span>` : '<span>Done</span>'}`;
      statusEl.title = `Succeeded${elapsedLabel ? ` in ${elapsedLabel}` : ''}`;
    }
  }
  const elapsed = shell.querySelector('.tool-elapsed');
  if (elapsed && p.endedMs !== undefined) {
    elapsed.textContent = elapsedLabel;
    elapsed.removeAttribute('data-started-at');
  }
}

function disposeTerm(p: PillRuntime): void {
  if (p.container) resizeObserver.unobserve(p.container);
  if (p.term) {
    try {
      p.term.dispose();
    } catch {
      // Already detached by a block re-render; nothing left to clean up.
    }
  }
  p.term = undefined;
  p.fit = undefined;
  p.container = undefined;
}

/** Create the xterm (or the <pre> fallback) for an open pill and replay its buffer. */
function ensureTerm(p: PillRuntime, shell: HTMLElement): void {
  if (p.term || p.fallbackPre) return;
  const container = shell.querySelector<HTMLElement>('.term-pill-term');
  if (!container) return;
  p.container = container;
  const bundle = xtermBundle();
  if (!bundle) {
    ensureFallback(p, container);
    return;
  }
  try {
    const term = new bundle.Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      disableStdin: true,
      convertEol: true,
      fontSize: 12,
      scrollback: 1000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: 'transparent', foreground: themeForeground() },
    });
    const fit = new bundle.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    p.term = term;
    p.fit = fit;
    resizeObserver.observe(container);
    if (p.buffer) term.write(p.buffer);
    fitTerm(p);
  } catch {
    disposeTerm(p);
    ensureFallback(p, container);
  }
}

function fitTerm(p: PillRuntime): void {
  if (!p.term || !p.fit || p.container?.isConnected !== true) return;
  try {
    p.fit.fit();
  } catch {
    // Not laid out yet; the next fit (toggle, resize, sync) fixes it.
  }
}

/** <pre> fallback: plain text with ANSI escapes stripped, tail kept. */
function ensureFallback(p: PillRuntime, container: HTMLElement): void {
  const pre = document.createElement('pre');
  pre.className = 'term-pill-fallback';
  pre.setAttribute('aria-live', 'polite');
  container.appendChild(pre);
  p.fallbackPre = pre;
  refreshFallback(p);
}

// Control characters cannot appear in regex literals (no-control-regex), so
// the ANSI patterns are built from the escape/bell characters at runtime.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const ANSI_CHARSET = new RegExp(`${ESC}[()][0-9A-B]`, 'g');
const ANSI_BEL = new RegExp(BEL, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, '').replace(ANSI_CHARSET, '').replace(ANSI_BEL, '');
}

function refreshFallback(p: PillRuntime): void {
  if (!p.fallbackPre) return;
  p.fallbackPre.textContent = stripAnsi(p.buffer.slice(-MAX_FALLBACK_CHARS));
  p.fallbackPre.scrollTop = p.fallbackPre.scrollHeight;
}

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const id = Number((entry.target as HTMLElement).dataset.pillTerm);
    const p = pills.get(id);
    if (p) fitTerm(p);
  }
});

window.addEventListener('resize', () => {
  for (const p of pills.values()) fitTerm(p);
});

/**
 * Pill accordions open/close between draws (user toggle): create the terminal
 * on open, dispose it on close. The chat's own toggle listener tracks the
 * disclosure sets; this one only manages xterm lifecycle.
 */
document.addEventListener(
  'toggle',
  (e) => {
    const target = e.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    if (!target.classList.contains('term-pill-fold')) return;
    if (!target.isConnected) return;
    syncPills();
  },
  true,
);
