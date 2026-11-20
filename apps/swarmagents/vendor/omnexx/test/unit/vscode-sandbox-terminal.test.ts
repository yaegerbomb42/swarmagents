import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class VsEmitter<T = unknown> {
    private listeners: ((e: T) => void)[] = [];
    get event(): (fn: (e: T) => void) => { dispose(): void } {
      return (fn: (e: T) => void) => {
        this.listeners.push(fn);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((l) => l !== fn);
          },
        };
      };
    }
    fire(e: T): void {
      for (const l of [...this.listeners]) l(e);
    }
    dispose(): void {
      this.listeners = [];
    }
  }

  return { VsEmitter };
});

vi.mock('vscode', () => ({
  EventEmitter: h.VsEmitter,
  window: {
    createTerminal: vi.fn((opts: { name: string; pty: unknown }) => ({
      name: opts.name,
      show: vi.fn(),
    })),
  },
}));

import { SandboxPseudoterminal } from '../../vscode/src/terminal/sandbox-terminal.js';
import { PtyBridge, type PtyBackend } from '../../src/sandbox/pty-bridge.js';

describe('Step 9.1: SandboxPseudoterminal', () => {
  function makeMockBackend(): PtyBackend & {
    written: string[];
    resized: { cols: number; rows: number }[];
    emitData: (chunk: string) => void;
    emitExit: (code: number) => void;
  } {
    let dataCb: ((chunk: string) => void) | null = null;
    let exitCb:
      ((info: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
    const written: string[] = [];
    const resized: { cols: number; rows: number }[] = [];

    return {
      pid: 12345,
      exitCode: null,
      written,
      resized,
      write(data: string) {
        written.push(data);
      },
      resize(cols: number, rows: number) {
        resized.push({ cols, rows });
      },
      onData(cb) {
        dataCb = cb;
        return () => {
          dataCb = null;
        };
      },
      onExit(cb) {
        exitCb = cb;
        return () => {
          exitCb = null;
        };
      },
      kill() {
        return;
      },
      emitData(chunk: string) {
        if (dataCb) dataCb(chunk);
      },
      emitExit(code: number) {
        if (exitCb) exitCb({ exitCode: code, signal: null });
      },
    };
  }

  const dummyRegistry = {
    register() {
      return;
    },
    unregister() {
      return;
    },
  };

  it('streams bridge data output through onDidWrite', () => {
    const mock = makeMockBackend();
    const bridge = new PtyBridge({
      command: 'echo',
      args: ['hello'],
      backend: () => mock,
      registry: dummyRegistry,
    }).start();

    const pty = new SandboxPseudoterminal({}, bridge);

    const received: string[] = [];
    pty.onDidWrite((chunk) => {
      received.push(chunk);
    });

    mock.emitData('Compilation finished with 0 errors\x1b[0m\n');
    expect(received).toEqual(['Compilation finished with 0 errors\x1b[0m\n']);
  });

  it('forwards handleInput and setDimensions to running bridge', () => {
    const mock = makeMockBackend();
    const bridge = new PtyBridge({
      command: 'bash',
      backend: () => mock,
      registry: dummyRegistry,
    }).start();

    const pty = new SandboxPseudoterminal({}, bridge);

    pty.handleInput('ls -la\n');
    expect(mock.written).toEqual(['ls -la\n']);

    pty.setDimensions({ columns: 120, rows: 40 });
    expect(mock.resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('fires onDidClose when the bridge exits', () => {
    const mock = makeMockBackend();
    const bridge = new PtyBridge({
      command: 'git',
      args: ['status'],
      backend: () => mock,
      registry: dummyRegistry,
    }).start();

    const pty = new SandboxPseudoterminal({}, bridge);

    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    let closedCode: number | void = -1;
    pty.onDidClose((code) => {
      closedCode = code;
    });

    mock.emitExit(0);
    expect(closedCode).toBe(0);
  });
});
