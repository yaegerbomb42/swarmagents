/**
 * Terminal pills for bash/shell tool calls (Phase 9, roadmap 9.2): the host side.
 *
 * What the chat server actually sends — and what it does not. The server emits
 * `state` frames whose `entries` are transcript lines only (src/cli/chat-server.ts):
 * a tool call surfaces as one `act` narration line (from the agent loop's
 * `tool.start` event, narrated by telemetry/narrate.ts — either a plain-English
 * description such as "running test suite" or "running `<command>`"), and a
 * failure as one `err` line (from `tool.call`, error text only). There is NO
 * discrete tool start/output/end event and NO stdout stream: `tool.call` carries
 * only `bytes`, `ms`, and the error text on failure. The tool's raw output goes
 * to the model, never to the webview.
 *
 * So pills are DERIVED from the transcript, in entry order (tool calls run
 * sequentially in the agent loop, so in-order attribution holds):
 * - a 'run'-kind `act` line starts a pill (id = the entry id — one act entry is
 *   one Block, since 'act' never joins in render.ts's addEntries — so the block
 *   id the webview renders from is the same id);
 * - the next `act` line of any kind, or any non-tool entry, or the turn going
 *   idle (`busy: false`) ends the open pill as success;
 * - an `err` line while a pill is open appends its text as a chunk and ends the
 *   pill as error.
 * The terminal therefore shows the command echo (`$ <cmd>`) plus the failure
 * line when the tool fails — the transcript the UI actually has — not the
 * tool's raw stdout, which the protocol never sends. Wiring real stdout
 * streaming would need a new `tool.output` event through the agent loop,
 * code-chat.ts, and the chat-server protocol; that is out of scope here.
 *
 * The pill is OUTPUT-ONLY: there is no stdin path from the pill back to the
 * running tool — the chat server owns the tool process and the protocol has no
 * input channel for it. The xterm instance is created with stdin disabled.
 *
 * Per-pill output is bounded (MAX_PILL_BUFFER_CHARS, tail kept) so re-expansion
 * can replay without unbounded growth. No `vscode` import here on purpose: the
 * manager only takes a post callback, so it is unit-testable from the root suite.
 */
import { extractPillCmd, toolKind, type PillStatus } from './webview/render.js';

/** Per-pill output retained for replay on (re-)expansion; tail kept past the cap. */
export const MAX_PILL_BUFFER_CHARS = 200_000;

interface OpenPill {
  id: number;
  cmd: string;
  isCommand: boolean;
  startedAt: number;
  buffer: string;
}

export class TerminalPillManager {
  private open: OpenPill | undefined;

  constructor(private readonly post: (msg: object) => void) {}

  /** Feed one chat-server `state` frame; posts pillStart/pillOutput/pillEnd. */
  observeState(m: { entries?: unknown; busy?: unknown } & Record<string, unknown>): void {
    if (Array.isArray(m.entries)) {
      for (const raw of m.entries) this.observeEntry(raw);
    }
    if (m.busy === false) this.endOpen('success');
  }

  /** End the open pill, if any (server down: the tool died with it). */
  endAll(status: PillStatus): void {
    this.endOpen(status);
  }

  /** Forget the open pill without posting (fresh panel/session: pills rebuild from the replay). */
  reset(): void {
    this.open = undefined;
  }

  private observeEntry(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as { id?: unknown; kind?: unknown; text?: unknown };
    if (typeof e.id !== 'number' || typeof e.kind !== 'string' || typeof e.text !== 'string')
      return;
    if (e.kind === 'act') {
      if (toolKind(e.text) === 'run') this.startPill(e.id, e.text);
      else this.endOpen('success');
      return;
    }
    if (e.kind === 'err') {
      if (!this.open) return;
      this.appendChunk(`${e.text}\n`);
      this.endOpen('error');
      return;
    }
    // Any other entry kind means the turn moved past tool execution.
    this.endOpen('success');
  }

  private startPill(id: number, line: string): void {
    if (this.open?.id === id) return;
    this.endOpen('success');
    const { cmd, isCommand } = extractPillCmd(line);
    this.open = { id, cmd, isCommand, startedAt: Date.now(), buffer: '' };
    this.post({ type: 'pillStart', id, cmd });
    this.appendChunk(isCommand ? `$ ${cmd}\n` : `${line.trim()}\n`);
  }

  private appendChunk(chunk: string): void {
    const pill = this.open;
    if (!pill) return;
    pill.buffer = (pill.buffer + chunk).slice(-MAX_PILL_BUFFER_CHARS);
    this.post({ type: 'pillOutput', id: pill.id, chunk });
  }

  private endOpen(status: PillStatus): void {
    const pill = this.open;
    if (!pill) return;
    this.open = undefined;
    this.post({
      type: 'pillEnd',
      id: pill.id,
      status,
      elapsedMs: Date.now() - pill.startedAt,
    });
  }
}
