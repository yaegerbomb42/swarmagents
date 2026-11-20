/**
 * Live terminal sessions for the chat webview drawer (Phase 9, roadmap 9.1/9.2):
 * a shell runs on the extension host and streams raw bytes to the webview, which
 * renders them with xterm.js and posts keystrokes back.
 *
 * No node-pty, no native deps: the backend spawns the shell with piped stdio
 * (`node:child_process`), so there is NO true PTY — the child sees pipes, not a
 * tty (`isatty` is false, no job control, no SIGWINCH). `resize` is tracked and
 * applied to COLUMNS/LINES for new spawns, not live. The `TerminalBackend`
 * interface is the seam: a real node-pty backend can be swapped in later
 * (roadmap 8.5) without touching the view or the webview protocol.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { primaryFolder } from './tree.js';

export interface TerminalSpawnOptions {
  cwd?: string | undefined;
  cols: number;
  rows: number;
}

/** A running shell session: write input, resize, kill; data/exit as events. */
export interface TerminalSession {
  readonly id: string;
  readonly command: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  dispose(): void;
  onData(listener: (chunk: string) => void): vscode.Disposable;
  onExit(listener: (code: number | null) => void): vscode.Disposable;
}

/** Spawns shell sessions. Swappable for a real node-pty backend later. */
export interface TerminalBackend {
  spawn(command: string, options: TerminalSpawnOptions): TerminalSession;
}

/** The user's login shell, or a plain fallback when none is configured. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}

/** Piped-spawn backend: the shell's stdin/stdout/stderr are pipes, not a tty. */
export class SpawnTerminalBackend implements TerminalBackend {
  private counter = 0;

  spawn(command: string, options: TerminalSpawnOptions): TerminalSession {
    const id = `term-${String(++this.counter)}`;
    const child = spawn(command, [], {
      cwd: options.cwd,
      env: {
        ...process.env,
        COLUMNS: String(options.cols),
        LINES: String(options.rows),
        TERM: 'xterm-256color',
      },
    });
    return new SpawnTerminalSession(id, command, child);
  }
}

class SpawnTerminalSession implements TerminalSession {
  private readonly dataEmitter = new vscode.EventEmitter<string>();
  private readonly exitEmitter = new vscode.EventEmitter<number | null>();
  readonly onData = this.dataEmitter.event;
  readonly onExit = this.exitEmitter.event;

  constructor(
    readonly id: string,
    readonly command: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.dataEmitter.fire(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.dataEmitter.fire(chunk.toString('utf8'));
    });
    child.on('error', (err: Error) => {
      this.dataEmitter.fire(`\r\n[omnexx: terminal failed to start: ${err.message}]\r\n`);
      this.exitEmitter.fire(null);
    });
    child.on('close', (code: number | null) => {
      this.exitEmitter.fire(code);
    });
  }

  write(data: string): void {
    if (this.child.exitCode === null && !this.child.stdin.destroyed) this.child.stdin.write(data);
  }

  resize(): void {
    // No true PTY: there is no window size to push and no SIGWINCH to send,
    // so the size is not applied to the running process. The view remembers
    // the size and uses it for COLUMNS/LINES on the next spawn; a future
    // node-pty backend will apply resizes live, and full-screen apps will
    // not reflow until the shell is restarted.
  }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill();
  }

  dispose(): void {
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    this.child.removeAllListeners();
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }
}

/**
 * The chat panel's live terminal: one drawer session at a time. The webview
 * owns the drawer UI; this side owns the process and posts
 * terminalStarted / terminalOutput / terminalExit / terminalSplit to it.
 */
export class TerminalView implements vscode.Disposable {
  private readonly backend: TerminalBackend;
  private readonly post: (msg: object) => void;
  private session: TerminalSession | undefined;
  private sessionSubs: vscode.Disposable[] = [];
  private splitView = false;
  /** Last size the webview reported; reused for COLUMNS/LINES on the next spawn. */
  private lastCols = 80;
  private lastRows = 24;

  constructor(post: (msg: object) => void, backend: TerminalBackend = new SpawnTerminalBackend()) {
    this.post = post;
    this.backend = backend;
  }

  get active(): boolean {
    return this.session !== undefined;
  }

  get isSplitView(): boolean {
    return this.splitView;
  }

  /** Start the drawer session (or re-show the running one) and tell the webview. */
  start(command?: string, cols: number = this.lastCols, rows: number = this.lastRows): void {
    if (this.session) {
      this.post({ type: 'terminalStarted', id: this.session.id, command: this.session.command });
      return;
    }
    const shell = command?.trim() ? command.trim() : defaultShell();
    const session = this.backend.spawn(shell, { cwd: primaryFolder(), cols, rows });
    this.session = session;
    this.sessionSubs.push(
      session.onData((chunk) => {
        this.post({ type: 'terminalOutput', id: session.id, data: chunk });
      }),
      session.onExit((code) => {
        this.post({ type: 'terminalExit', id: session.id, code });
        this.clearSession(session);
      }),
    );
    this.post({ type: 'terminalStarted', id: session.id, command: shell });
  }

  write(data: string): void {
    this.session?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    this.session?.resize(cols, rows);
  }

  stop(): void {
    const session = this.session;
    if (!session) return;
    session.kill();
    this.clearSession(session);
  }

  toggleSplitView(): void {
    this.splitView = !this.splitView;
    this.post({ type: 'terminalSplit', on: this.splitView });
  }

  dispose(): void {
    this.stop();
  }

  private clearSession(session: TerminalSession): void {
    if (this.session !== session) return;
    this.session = undefined;
    for (const s of this.sessionSubs) s.dispose();
    this.sessionSubs = [];
    session.dispose();
  }
}
