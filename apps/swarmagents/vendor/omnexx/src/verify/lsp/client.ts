import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { registerChild, unregisterChild } from '../../core/process-registry.js';
import { normalizeLspDiagnostic } from '../diagnostics.js';
import type { Diagnostic } from '../preflight-types.js';
import type { RawLspDiagnostic } from '../diagnostics.js';

export interface LspClientOptions {
  root: string;
  language: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  input?: Readable;
  output?: Writable;
  spawn?: (command: string, args: string[]) => ChildProcess;
}

interface LspResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface LspNotification {
  jsonrpc: string;
  method: string;
  params?: {
    uri?: string;
    diagnostics?: RawLspDiagnostic[];
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class PersistentLspClient {
  readonly root: string;
  readonly language: string;
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly cwd: string | undefined;
  private readonly spawnFn: ((command: string, args: string[]) => ChildProcess) | undefined;

  private child: ChildProcess | null = null;
  private input: Readable | null = null;
  private output: Writable | null = null;
  private ownedStreams = false;

  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private onDiagnosticsCallback: ((uri: string, diagnostics: Diagnostic[]) => void) | undefined;
  private started = false;
  private closed = false;

  constructor(options: LspClientOptions) {
    this.root = options.root;
    this.language = options.language;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.command = options.command ?? '';
    this.args = options.args ?? [];
    this.env = options.env;
    this.cwd = options.cwd ?? options.root;
    this.spawnFn = options.spawn;
    if (options.input && options.output) {
      this.input = options.input;
      this.output = options.output;
      this.ownedStreams = false;
    }
  }

  get isStarted(): boolean {
    return this.started;
  }

  onDiagnostics(cb: (uri: string, diagnostics: Diagnostic[]) => void): void {
    this.onDiagnosticsCallback = cb;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.input || !this.output) {
      if (!this.command) {
        throw new Error(`No command configured for ${this.language} LSP client`);
      }
      const opts: SpawnOptions = {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: 'pipe',
      };
      const child = this.spawnFn
        ? this.spawnFn(this.command, this.args)
        : spawn(this.command, this.args, opts);
      this.child = child;
      this.input = child.stdout;
      this.output = child.stdin;
      this.ownedStreams = true;
      if (child.pid !== undefined) {
        registerChild({
          pid: child.pid,
          pgid: child.pid,
          kind: 'daemon',
          command: [this.command, ...this.args].join(' '),
        });
      }
      child.on('close', () => {
        if (child.pid !== undefined) unregisterChild(child.pid);
        this.closed = true;
      });
    }
    if (this.input) this.attachInput(this.input);
    this.started = true;
    try {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: `file://${this.root}`,
        capabilities: {},
      });
      this.notify('initialized', {});
    } catch {
      // Best effort.
    }
  }

  private attachInput(stream: Readable): void {
    stream.on('data', (chunk: Buffer | string) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.drainBuffer();
    });
  }

  private drainBuffer(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: LspResponse | LspNotification;
    try {
      msg = JSON.parse(body) as LspResponse | LspNotification;
    } catch {
      return;
    }
    if (
      typeof (msg as LspResponse).id === 'number' &&
      ((msg as LspResponse).result !== undefined || (msg as LspResponse).error !== undefined)
    ) {
      const response = msg as LspResponse;
      const id = response.id as number;
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (response.error) {
          pending.reject(new Error(response.error.message ?? 'LSP error'));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }
    const notification = msg as LspNotification;
    if (notification.method === 'textDocument/publishDiagnostics') {
      const params = notification.params ?? {};
      const uri = params.uri ?? '';
      const raw = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      const diags = raw.map((d) => normalizeLspDiagnostic(uriToPath(uri), d, this.defaultSource()));
      this.diagnosticsByUri.set(uri, diags);
      this.onDiagnosticsCallback?.(uri, diags);
    }
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
      if (!this.output) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('LSP client not started'));
        return;
      }
      this.output.write(frame);
    });
  }

  notify(method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    this.output?.write(frame);
  }

  async diagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[]> {
    try {
      const result = await this.request(
        'textDocument/diagnostic',
        { textDocument: { uri } },
        timeoutMs ?? this.timeoutMs,
      );
      const obj = result as { items?: RawLspDiagnostic[] } | null;
      const items = Array.isArray(obj?.items) ? obj.items : [];
      return items.map((d) => normalizeLspDiagnostic(uriToPath(uri), d, this.defaultSource()));
    } catch {
      return this.diagnosticsByUri.get(uri) ?? [];
    }
  }

  private defaultSource(): string {
    return this.language === 'python' ? 'pyright' : 'rust-analyzer';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request('shutdown', null, 1_000).catch(() => undefined);
    } catch {
      // ignore
    }
    this.notify('exit', null);
    if (this.child) {
      const pid = this.child.pid;
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      if (pid !== undefined) unregisterChild(pid);
    }
    if (this.output && this.ownedStreams) {
      try {
        this.output.end();
      } catch {
        // ignore
      }
    }
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('LSP client closed'));
    });
    this.pending.clear();
  }
}

function uriToPath(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(uri.replace('file://', ''));
    } catch {
      return uri.replace('file://', '');
    }
  }
  return uri;
}
