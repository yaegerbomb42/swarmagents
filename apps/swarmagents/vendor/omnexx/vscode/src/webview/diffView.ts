/**
 * Split-diff viewer webview (Phase 9, roadmap 9.3): renders one patch from
 * the host as a split diff with context folding. The host posts
 * `{ type: 'diff', id, file, original, proposed }` after this script posts
 * `{ type: 'ready' }`; the header's Accept / Reject & Re-roll buttons post
 * `{ type: 'accept' | 'reject', id }` back.
 *
 * Layout is client-side state (default side-by-side) and re-renders from the
 * folded view, so toggling never recomputes the diff. Folded regions render
 * as one banner row — that is the virtualization in scope: a 10,000-line
 * unchanged run costs one banner row of DOM, not 10,000 rows.
 */
import { buildFoldedView, computeDiff, expandFold, type FoldedView } from '../diff-model.js';
import { escapeHtml } from './render.js';

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface DiffMessage {
  type: 'diff';
  id: string;
  file: string;
  original: string;
  proposed: string;
}

type Mode = 'side' | 'unified';

const vscode = acquireVsCodeApi();

let patchId = '';
let fileName = '';
let view: FoldedView = { rows: [], folds: [] };
let mode: Mode = 'side';

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`missing #${id}`);
  return found;
}

/** A code cell: escaped text, kept on one line; empty lines stay visible. */
function codeCell(text: string): string {
  const escaped = escapeHtml(text);
  return escaped === '' ? '&nbsp;' : escaped;
}

function gutterCell(num: number | null): string {
  return `<td class="diff-gutter">${num === null ? '' : String(num)}</td>`;
}

function foldBanner(foldId: number, count: number): string {
  return `<tr class="diff-fold"><td colspan="4"><button class="diff-fold-banner" data-fold="${String(foldId)}" type="button">... [${String(count)} unchanged lines folded] …</button></td></tr>`;
}

function renderSide(): string {
  const rows = view.rows
    .map((row) => {
      if (row.type === 'fold') return foldBanner(row.foldId, row.count);
      const line = row.line;
      if (line.kind === 'unchanged') {
        return `<tr class="diff-line diff-unchanged">${gutterCell(line.oldLine)}<td class="diff-code">${codeCell(line.text)}</td>${gutterCell(line.newLine)}<td class="diff-code">${codeCell(line.text)}</td></tr>`;
      }
      if (line.kind === 'added') {
        return `<tr class="diff-line diff-added">${gutterCell(null)}<td class="diff-code"></td>${gutterCell(line.newLine)}<td class="diff-code">${codeCell(line.text)}</td></tr>`;
      }
      return `<tr class="diff-line diff-removed">${gutterCell(line.oldLine)}<td class="diff-code">${codeCell(line.text)}</td>${gutterCell(null)}<td class="diff-code"></td></tr>`;
    })
    .join('');
  return `<table class="diff-table diff-side"><tbody>${rows}</tbody></table>`;
}

function renderUnified(): string {
  const rows = view.rows
    .map((row) => {
      if (row.type === 'fold') return foldBanner(row.foldId, row.count);
      const line = row.line;
      const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
      return `<tr class="diff-line diff-${line.kind}">${gutterCell(line.oldLine)}${gutterCell(line.newLine)}<td class="diff-marker">${marker}</td><td class="diff-code">${codeCell(line.text)}</td></tr>`;
    })
    .join('');
  return `<table class="diff-table diff-unified"><tbody>${rows}</tbody></table>`;
}

function render(): void {
  const app = el('app', HTMLDivElement);
  app.innerHTML = `<header class="diff-header">
  <span class="diff-file" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
  <div class="diff-toggle" role="group" aria-label="Diff layout">
    <button type="button" data-mode="side" aria-pressed="${mode === 'side' ? 'true' : 'false'}">Side-by-Side</button>
    <button type="button" data-mode="unified" aria-pressed="${mode === 'unified' ? 'true' : 'false'}">Unified</button>
  </div>
  <div class="diff-actions">
    <button type="button" class="diff-accept" data-action="accept">Accept Patch</button>
    <button type="button" class="diff-reject" data-action="reject">Reject &amp; Re-roll</button>
  </div>
</header>
<div class="diff-body">${mode === 'side' ? renderSide() : renderUnified()}</div>`;
}

function isDiffMessage(data: unknown): data is DiffMessage {
  if (!data || typeof data !== 'object') return false;
  const msg = data as {
    type?: unknown;
    id?: unknown;
    file?: unknown;
    original?: unknown;
    proposed?: unknown;
  };
  return (
    msg.type === 'diff' &&
    typeof msg.id === 'string' &&
    typeof msg.file === 'string' &&
    typeof msg.original === 'string' &&
    typeof msg.proposed === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!isDiffMessage(event.data)) return;
  patchId = event.data.id;
  fileName = event.data.file;
  view = buildFoldedView(computeDiff(event.data.original, event.data.proposed));
  mode = 'side';
  render();
});

el('app', HTMLDivElement).addEventListener('click', (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const foldButton = target.closest('[data-fold]');
  if (foldButton instanceof HTMLElement) {
    const id = Number(foldButton.dataset.fold);
    if (Number.isInteger(id)) {
      view = expandFold(view, id);
      render();
    }
    return;
  }
  const modeButton = target.closest('[data-mode]');
  if (modeButton instanceof HTMLElement) {
    const next = modeButton.dataset.mode;
    if (next === 'side' || next === 'unified') {
      mode = next;
      render();
    }
    return;
  }
  const actionButton = target.closest('[data-action]');
  if (actionButton instanceof HTMLElement) {
    const action = actionButton.dataset.action;
    if (action === 'accept' || action === 'reject') {
      vscode.postMessage({ type: action, id: patchId });
    }
  }
});

vscode.postMessage({ type: 'ready' });
