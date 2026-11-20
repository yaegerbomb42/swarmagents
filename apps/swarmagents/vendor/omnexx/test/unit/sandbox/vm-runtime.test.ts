import { describe, expect, it } from 'vitest';
import {
  VmRuntime,
  VmUnavailableError,
  formatColimaExec,
  formatLimactlExec,
  type RunBinary,
  type VmProbe,
} from '../../../src/sandbox/runtime/vm-runtime.js';
import type { ISandboxRuntime, SandboxRunResult } from '../../../src/sandbox/runtime/types.js';

describe('Step 8.4: Apple Silicon / Colima MicroVM Runtime', () => {
  it('formats colima and limactl command argv properly', () => {
    const colimaArgv = formatColimaExec('ls', ['-la', '/workspace']);
    expect(colimaArgv).toEqual(['colima', 'ssh', '--', 'ls', '-la', '/workspace']);

    const limaArgv = formatLimactlExec('default', 'python3', ['-m', 'pytest']);
    expect(limaArgv).toEqual(['limactl', 'shell', 'default', '--', 'python3', '-m', 'pytest']);
  });

  it('runs command inside Colima VM when probe detects Colima available', async () => {
    let executedArgv: readonly string[] = [];

    const mockRunBinary: RunBinary = async (argv) => {
      await Promise.resolve();
      executedArgv = argv;
      return {
        exitCode: 0,
        stdout: 'total 0\n',
        stderr: '',
        timedOut: false,
        durationMs: 42,
      };
    };

    const mockProbe: VmProbe = async () => {
      await Promise.resolve();
      return {
        available: true,
        driver: 'colima',
        instance: 'default',
      };
    };

    const vm = new VmRuntime({
      runBinary: mockRunBinary,
      probe: mockProbe,
    });

    const isAvail = await vm.isAvailable();
    expect(isAvail).toBe(true);

    const res = await vm.run({ command: 'echo', args: ['hello'] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('total 0\n');
    expect(executedArgv).toEqual(['colima', 'ssh', '--', 'echo', 'hello']);
  });

  it('delegates to fallback runtime when VM is unavailable', async () => {
    let fallbackCalled = false;
    const fallback: ISandboxRuntime = {
      kind: 'worktree',
      isAvailable: async () => {
        await Promise.resolve();
        return true;
      },
      run: async (): Promise<SandboxRunResult> => {
        await Promise.resolve();
        fallbackCalled = true;
        return {
          exitCode: 0,
          stdout: 'from-fallback',
          stderr: '',
          timedOut: false,
          durationMs: 10,
        };
      },
      cleanup: async () => {
        await Promise.resolve();
      },
    };

    const mockProbe: VmProbe = async () => {
      await Promise.resolve();
      return {
        available: false,
        instance: 'default',
        reason: 'colima daemon not running',
      };
    };

    const vm = new VmRuntime({
      probe: mockProbe,
      fallback,
    });

    const isAvail = await vm.isAvailable();
    expect(isAvail).toBe(false);

    const res = await vm.run({ command: 'test' });
    expect(fallbackCalled).toBe(true);
    expect(res.stdout).toBe('from-fallback');
  });

  it('throws VmUnavailableError when unavailable and no fallback runtime is configured', async () => {
    const mockProbe: VmProbe = async () => {
      await Promise.resolve();
      return {
        available: false,
        instance: 'default',
        reason: 'no VM daemon installed',
      };
    };

    const vm = new VmRuntime({
      probe: mockProbe,
    });

    await expect(vm.run({ command: 'test' })).rejects.toThrow(VmUnavailableError);
  });
});
