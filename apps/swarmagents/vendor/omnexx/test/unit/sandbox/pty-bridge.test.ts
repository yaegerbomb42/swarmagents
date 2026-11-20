import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../../src/core/lock.js';
import {
  bindRun,
  readChildren,
  unbindRun,
  type ChildEntry,
} from '../../../src/core/process-registry.js';
import type { OmnexxPaths } from '../../../src/core/paths.js';
import {
  PtyBridge,
  spawnPty,
  type PtyBackend,
  type PtyExitInfo,
  type PtyRegistry,
} from '../../../src/sandbox/pty-bridge.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAllDead(pids: readonly number[], timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return true;
    await sleep(50);
  }
  return pids.every((pid) => !pidAlive(pid));
}

/** A deterministic spy backend so resize/write/event/registration semantics are testable. */
class FakeBackend implements PtyBackend {
  pid = 4242;
  exitCode: number | null = null;
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  private readonly dataCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(info: PtyExitInfo) => void>();

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
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

  kill(): void {
    // Emulating a coerced teardown so dispose() resolves promptly in tests.
    this.emitExit({ exitCode: null, signal: 'SIGTERM' });
  }

  emitData(chunk: string): void {
    for (const cb of this.dataCbs) cb(chunk);
  }

  emitExit(info: PtyExitInfo): void {
    this.exitCode = info.exitCode;
    for (const cb of this.exitCbs) cb(info);
  }
}

const runNode = (script: string) => ({
  command: process.execPath,
  args: ['-e', script],
});

describe('PtyBridge spawn and exit codes', () => {
  it('spawns a process and reports its pid and clean exit code', async () => {
    const bridge = spawnPty(runNode('process.exit(0)'));
    expect(bridge.pid).toBeGreaterThan(0);
    const info = await bridge.waitForExit(5_000);
    expect(info.exitCode).toBe(0);
    expect(bridge.exited).toBe(true);
    expect(bridge.exitCode).toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    const bridge = spawnPty(runNode('process.exit(7)'));
    await expect(bridge.waitForExit(5_000)).resolves.toMatchObject({ exitCode: 7 });
  });
});

describe('PtyBridge streaming', () => {
  it('forwards stdout as data chunks', async () => {
    const chunks: string[] = [];
    const bridge = spawnPty(runNode('process.stdout.write("ping")'));
    bridge.onData((chunk) => chunks.push(chunk));
    await bridge.waitForExit(5_000);
    expect(chunks.join('')).toContain('ping');
  });

  it('merges stderr into the data stream (ANSI propagation)', async () => {
    const chunks: string[] = [];
    const bridge = spawnPty(runNode('process.stderr.write("\\u001b[31merr\\u001b[0m")'));
    bridge.onData((chunk) => chunks.push(chunk));
    await bridge.waitForExit(5_000);
    expect(chunks.join('')).toContain('err');
  });
});

describe('PtyBridge backend surface (spy backend)', () => {
  let backend: FakeBackend;
  let entries: ChildEntry[];
  let unregistered: number[];
  let registry: PtyRegistry;

  beforeEach(() => {
    backend = new FakeBackend();
    entries = [];
    unregistered = [];
    registry = {
      register: (entry) => entries.push(entry),
      unregister: (pid) => unregistered.push(pid),
    };
  });

  it('registers on start and unregisters on dispose', async () => {
    const bridge = new PtyBridge({
      command: 'fake',
      kind: 'shell',
      backend: () => backend,
      registry,
    }).start();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pid).toBe(4242);
    expect(entries[0]?.kind).toBe('shell');
    expect(entries[0]?.command).toBe('fake');
    expect(bridge.pid).toBe(4242);
    await bridge.dispose();
    expect(unregistered).toEqual([4242]);
  });

  it('start is idempotent and does not double-register', () => {
    const bridge = new PtyBridge({
      command: 'fake',
      backend: () => backend,
      registry,
    });
    bridge.start();
    bridge.start();
    expect(entries).toHaveLength(1);
  });

  it('forwards writes and resizes to the backend', () => {
    const bridge = new PtyBridge({ command: 'fake', backend: () => backend, registry }).start();
    bridge.write('hello');
    bridge.resize(100, 40);
    expect(backend.written).toEqual(['hello']);
    expect(backend.resizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  it('delivers data and exit events, and unsubscribe stops delivery', () => {
    const bridge = new PtyBridge({ command: 'fake', backend: () => backend, registry }).start();
    const seen: string[] = [];
    const off = bridge.onData((chunk) => seen.push(chunk));
    backend.emitData('a');
    backend.emitData('b');
    off();
    backend.emitData('c');
    expect(seen).toEqual(['a', 'b']);

    const exited: PtyExitInfo[] = [];
    bridge.onExit((info) => exited.push(info));
    backend.emitExit({ exitCode: 3, signal: null });
    expect(bridge.exitCode).toBe(3);
    expect(exited[0]).toEqual({ exitCode: 3, signal: null });
  });
});

describe('PtyBridge dispose (real process group)', () => {
  // The detached spawn makes the child a group leader; killing the group must
  // also take down grandchildren (background jobs) of the child.
  it('terminates the whole process group on dispose', async () => {
    if (process.platform === 'win32') return; // process groups behave differently here
    const chunks: string[] = [];
    const bridge = spawnPty({
      command: '/bin/sh',
      args: ['-c', 'sleep 60 & echo $!; wait'],
    });
    bridge.onData((chunk) => chunks.push(chunk));

    let grandchild = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && grandchild === 0) {
      const match = /(\d+)/.exec(chunks.join(''));
      if (match !== null) {
        const parsed = Number(match[1]);
        if (parsed > 0) grandchild = parsed;
      }
      await sleep(40);
    }
    expect(grandchild).toBeGreaterThan(0);

    const childPid = bridge.pid;
    await bridge.dispose();
    expect(await waitForAllDead([childPid, grandchild])).toBe(true);
  });
});

describe('PtyBridge registration with the process registry', () => {
  let home: string;
  let paths: OmnexxPaths;
  const runId = 'pty-test-run';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'omnexx-pty-reg-'));
    paths = { home, configHome: join(home, 'config') };
    bindRun(paths, runId);
  });

  afterEach(() => {
    unbindRun();
  });

  it('registers a spawned child and removes it on dispose', async () => {
    const bridge = spawnPty({ ...runNode('process.exit(0)'), kind: 'shell' });
    await bridge.waitForExit(5_000);
    const entries = readChildren(paths, runId);
    expect(entries.some((entry) => entry.pid === bridge.pid && entry.kind === 'shell')).toBe(true);

    await bridge.dispose();
    const after = readChildren(paths, runId);
    expect(after.some((entry) => entry.pid === bridge.pid)).toBe(false);
  });
});
