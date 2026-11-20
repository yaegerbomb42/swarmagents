import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  registerChild,
  unregisterChild,
  type ChildEntry,
  type ChildKind,
} from '../core/process-registry.js';

/**
 * PtyBridge spawns a sandboxed command under a pseudo-terminal and exposes the
 * tiny, terminal-like surface a worker needs: `write`, `resize`, `onData` and
 * `onExit`. It is the Step 8.5 bridge between an interactive child process and
 * the rest of Omnexx.
 *
 * Backend: when `node-pty` is installed it is used (a real PTY: stdout and
 * stderr share one stream, resize is honoured, the process is tied to a PTY
 * session). Otherwise a `child_process` fallback is used: the child is spawned
 * detached (its own process group, so it can be torn down as a unit) and its
 * stdout/stderr are merged into a single data stream, mirroring a terminal.
 *
 * Every live bridge is registered with the process registry so the supervisor
 * can reap it; `dispose()` sends the term/kill sequence to the whole process
 * group and unregisters it.
 */

/** What a PTY session reports when it ends. */
export interface PtyExitInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The narrow contract the bridge needs from a terminal backend. The producer
 * (node-pty or child_process) is hidden behind this so the rest of PtyBridge is
 * backend-agnostic and testable with a spy.
 */
export interface PtyBackend {
  readonly pid: number;
  readonly exitCode: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (info: PtyExitInfo) => void): () => void;
  kill(signal?: NodeJS.Signals): void;
}

/** Factory that produces the backend for a PtyBridge. Injected in tests. */
export type PtyBackendFactory = (options: PtyBridgeOptions) => PtyBackend;

/** Minimal process-registry surface PtyBridge depends on. Injected in tests. */
export interface PtyRegistry {
  register(entry: ChildEntry): void;
  unregister(pid: number): void;
}

export interface PtyBridgeOptions {
  /** The command to run inside the pseudo-terminal. */
  command: string;
  /** Arguments passed to the command. */
  args?: readonly string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra environment merged over the parent's. */
  env?: NodeJS.ProcessEnv;
  /** Initial terminal width in columns (used when a real pty is available). */
  cols?: number;
  /** Initial terminal height in rows. */
  rows?: number;
  /** Label recorded in the process registry. Defaults to `command`. */
  name?: string;
  /** How the child is classified in the process registry. Defaults to 'task'. */
  kind?: ChildKind;
  /** Process-registry hooks; defaults to Omnexx's process-registry. */
  registry?: PtyRegistry;
  /** Backend factory; defaults to node-pty when present, else child_process. */
  backend?: PtyBackendFactory;
}

/* ----------------------------------------------------------------------------
 * node-pty backend (used when the optional dependency is installed).
 * -------------------------------------------------------------------------- */

/** The tiny shape of the node-pty module we use. */
interface NodePtyLib {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      useConpty?: boolean;
    },
  ): NodePtyProcess;
}

/** The tiny shape of a node-pty process we use. */
interface NodePtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number, signal?: number) => void): void;
  kill(signal?: string): void;
}

/** Load node-pty if it is installed; returns undefined otherwise. */
function loadNodePty(): NodePtyLib | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('node-pty') as unknown;
    if (
      typeof mod === 'object' &&
      mod !== null &&
      typeof (mod as NodePtyLib).spawn === 'function'
    ) {
      return mod as NodePtyLib;
    }
  } catch {
    // node-pty is an optional dependency; fall back to child_process.
  }
  return undefined;
}

class NodePtyBackend implements PtyBackend {
  private readonly proc: NodePtyProcess;
  private readonly dataCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(info: PtyExitInfo) => void>();
  private exitInfo: PtyExitInfo = { exitCode: null, signal: null };

  constructor(lib: NodePtyLib, options: PtyBridgeOptions) {
    this.proc = lib.spawn(options.command, options.args ?? [], {
      name: options.name ?? options.command,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' },
      useConpty: true,
    });
    this.proc.onData((data) => {
      for (const cb of this.dataCbs) cb(data);
    });
    this.proc.onExit((code) => {
      this.exitInfo = { exitCode: code, signal: null };
      for (const cb of this.exitCbs) cb(this.exitInfo);
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get exitCode(): number | null {
    return this.exitInfo.exitCode;
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.add(cb);
    return () => {
      this.dataCbs.delete(cb);
    };
  }

  onExit(cb: (info: PtyExitInfo) => void): () => void {
    this.exitCbs.add(cb);
    return () => {
      this.exitCbs.delete(cb);
    };
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      this.proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

/* ----------------------------------------------------------------------------
 * child_process fallback backend (used when node-pty is absent). The child is
 * spawned detached so it leads its own process group, which the supervisor can
 * terminate as a unit. stdout and stderr are merged into one data stream,
 * matching a terminal's behaviour.
 * -------------------------------------------------------------------------- */

class ChildPtyBackend implements PtyBackend {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(info: PtyExitInfo) => void>();
  private exitInfo: PtyExitInfo = { exitCode: null, signal: null };

  constructor(options: PtyBridgeOptions) {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    child.stdout.on('data', (buf: Buffer) => {
      this.emitData(buf.toString('utf8'));
    });
    child.stderr.on('data', (buf: Buffer) => {
      this.emitData(buf.toString('utf8'));
    });
    child.on('error', () => {
      this.exitInfo = { exitCode: null, signal: 'SIGTERM' };
      this.emitExit(this.exitInfo);
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { exitCode: code, signal };
      this.emitExit(this.exitInfo);
    });
  }

  private emitData(chunk: string): void {
    for (const cb of this.dataCbs) cb(chunk);
  }

  private emitExit(info: PtyExitInfo): void {
    for (const cb of this.exitCbs) cb(info);
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get exitCode(): number | null {
    return this.exitInfo.exitCode;
  }

  write(data: string): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(data);
  }

  resize(): void {
    // No real pty in the fallback: there is nothing to resize. Kept as a
    // no-op so the bridge surface is identical regardless of backend.
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.add(cb);
    return () => {
      this.dataCbs.delete(cb);
    };
  }

  onExit(cb: (info: PtyExitInfo) => void): () => void {
    this.exitCbs.add(cb);
    return () => {
      this.exitCbs.delete(cb);
    };
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    // The child leads its own process group (detached spawn): signal the whole
    // group first, then fall back to the bare pid. A failed spawn leaves pid -1:
    // process.kill(-(-1)) would target PID 1, and process.kill(-1) would
    // broadcast to every process the caller may signal — so never group-kill
    // an invalid pid; the bare child.kill on a failed spawn is a no-op.
    if (this.pid > 0) {
      try {
        process.kill(-this.pid, signal);
        return;
      } catch {
        // fall through to the bare pid
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }
}

const defaultBackendFactory: PtyBackendFactory = (options) => {
  const lib = loadNodePty();
  return lib !== undefined ? new NodePtyBackend(lib, options) : new ChildPtyBackend(options);
};

const builtInRegistry: PtyRegistry = {
  register(entry) {
    registerChild(entry);
  },
  unregister(pid) {
    unregisterChild(pid);
  },
};

/**
 * A pseudo-terminal bridge for a sandboxed command. Create one, call `start()`
 * (or use the `spawnPty` helper), then feed it via `write`, watch `onData`,
 * resize via `resize`, and tear it down with `dispose()`.
 */
export class PtyBridge {
  private readonly options: PtyBridgeOptions;
  private readonly registry: PtyRegistry;
  private backend: PtyBackend | null = null;
  private disposed = false;
  private readonly dataCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(info: PtyExitInfo) => void>();
  private _exitCode: number | null = null;
  private _exited = false;
  private exitPromise: Promise<PtyExitInfo> | null = null;
  private resolveExit: ((info: PtyExitInfo) => void) | null = null;

  constructor(options: PtyBridgeOptions) {
    this.options = options;
    this.registry = options.registry ?? builtInRegistry;
  }

  /** Spawn the terminal session. Idempotent. */
  start(): this {
    if (this.backend !== null) return this;
    const backend = (this.options.backend ?? defaultBackendFactory)(this.options);
    this.backend = backend;
    backend.onData((chunk) => {
      for (const cb of this.dataCbs) cb(chunk);
    });
    backend.onExit((info) => {
      this.handleExit(info);
    });
    // A failed spawn leaves pid -1: there is no process to track, and
    // registering it would hand the reaper an entry it must never signal.
    if (backend.pid > 0) {
      this.registry.register({
        pid: backend.pid,
        pgid: backend.pid,
        kind: this.options.kind ?? 'task',
        command: this.options.name ?? this.options.command,
        startedAt: Date.now(),
      });
    }
    return this;
  }

  /** The OS pid of the spawned process (or -1 before start). */
  get pid(): number {
    return this.backend?.pid ?? -1;
  }

  /** The process exit code once it ends, else null. */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /** Whether the process has ended (by exit or by dispose). */
  get exited(): boolean {
    return this._exited;
  }

  /** Write a chunk to the terminal (stdin of the child). */
  write(data: string): void {
    this.start();
    if (this.backend !== null) this.backend.write(data);
  }

  /** Resize the terminal. No-op when the backend has no real terminal. */
  resize(cols: number, rows: number): void {
    this.start();
    if (this.backend !== null) this.backend.resize(cols, rows);
  }

  /** Subscribe to merged output chunks. Returns an unsubscribe function. */
  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.add(cb);
    return () => {
      this.dataCbs.delete(cb);
    };
  }

  /** Subscribe to the terminal closing. Returns an unsubscribe function. */
  onExit(cb: (info: PtyExitInfo) => void): () => void {
    this.exitCbs.add(cb);
    return () => {
      this.exitCbs.delete(cb);
    };
  }

  /**
   * Resolve when the terminal closes (or immediately if it already has). With a
   * finite `timeoutMs`, resolves with the current exit info when the timeout
   * lapses.
   */
  waitForExit(timeoutMs = Number.POSITIVE_INFINITY): Promise<PtyExitInfo> {
    const promise = this._exited
      ? Promise.resolve(this.currentExitInfo())
      : this.exitPromiseOrCreate();
    if (timeoutMs === Number.POSITIVE_INFINITY) return promise;
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).then((info) => info ?? this.currentExitInfo());
  }

  /**
   * SIGTERM the whole process group, wait a short grace for a clean exit, then
   * SIGKILL the group if it is still alive, and unregister the child. Safe to
   * call more than once.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const backend = this.backend;
    const pid = backend?.pid;
    if (backend !== null && !this._exited) {
      backend.kill('SIGTERM');
      await this.waitForExit(3_000);
      // SIGKILL the group if it is still alive; a dead group is a no-op.
      backend.kill('SIGKILL');
    }
    this.backend = null;
    if (pid !== undefined) this.registry.unregister(pid);
  }

  private currentExitInfo(): PtyExitInfo {
    return { exitCode: this._exitCode, signal: null };
  }

  private exitPromiseOrCreate(): Promise<PtyExitInfo> {
    this.exitPromise ??= new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    return this.exitPromise;
  }

  private handleExit(info: PtyExitInfo): void {
    this._exitCode = info.exitCode;
    this._exited = true;
    for (const cb of this.exitCbs) cb(info);
    if (this.resolveExit !== null) this.resolveExit(info);
  }
}

/** Convenience: spawn and start a PtyBridge in one call. */
export function spawnPty(options: PtyBridgeOptions): PtyBridge {
  return new PtyBridge(options).start();
}
