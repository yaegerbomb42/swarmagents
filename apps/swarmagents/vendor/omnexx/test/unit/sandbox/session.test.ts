import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxSession } from '../../../src/sandbox/session.js';
import type { ISandboxRuntime, SandboxRunResult } from '../../../src/sandbox/runtime/types.js';
import { PathJailViolationError } from '../../../src/security/path-jail.js';

describe('Step 8.6: SandboxSession and Execution Loop Wiring', () => {
  let tempRoot: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), 'omnexx-session-test-'));
    tempRoot = realpathSync.native(raw);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('initializes session and asserts paths within root', async () => {
    const session = await SandboxSession.create({ workspaceRoot: tempRoot });
    expect(session.jailRoot).toBe(tempRoot);

    const valid = session.assertPath('src/file.ts');
    expect(valid).toBe(join(tempRoot, 'src/file.ts'));

    expect(() => session.assertPath('../../etc/passwd')).toThrow(PathJailViolationError);
    await session.cleanup();
  });

  it('delegates execute to active ISandboxRuntime when available', async () => {
    let runtimeCalledWith: unknown = null;
    const mockRuntime: ISandboxRuntime = {
      kind: 'vm',
      isAvailable: async () => {
        await Promise.resolve();
        return true;
      },
      run: async (opts): Promise<SandboxRunResult> => {
        await Promise.resolve();
        runtimeCalledWith = opts;
        return {
          exitCode: 0,
          stdout: 'output from vm',
          stderr: '',
          timedOut: false,
          durationMs: 15,
        };
      },
      cleanup: async () => {
        // no-op
      },
    };

    const session = await SandboxSession.create({
      workspaceRoot: tempRoot,
      runtime: mockRuntime,
    });

    const res = await session.execute({
      command: 'pytest',
      args: ['-v'],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('output from vm');
    expect(runtimeCalledWith).toMatchObject({
      command: 'pytest',
      args: ['-v'],
      cwd: tempRoot,
    });

    await session.cleanup();
  });

  it('spawns interactive PTY bridge bound to the session root', async () => {
    const session = await SandboxSession.create({ workspaceRoot: tempRoot });
    const pty = session.spawnPty({
      command: 'echo',
      args: ['sandbox-online'],
    });

    expect(pty).toBeDefined();
    const exitInfo = await pty.waitForExit(5000);
    expect(exitInfo.exitCode).toBe(0);

    await session.cleanup();
  });

  it('creates and cleans up isolated shadow workspace when useShadow is true', async () => {
    const session = await SandboxSession.create({
      workspaceRoot: tempRoot,
      useShadow: true,
    });

    expect(session.jailRoot).not.toBe(tempRoot);
    expect(session.jailRoot).toContain('omnexx-shadow-');

    await session.cleanup();
  });
});
