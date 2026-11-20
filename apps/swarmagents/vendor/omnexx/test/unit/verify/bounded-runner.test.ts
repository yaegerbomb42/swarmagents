import { describe, expect, it } from 'vitest';
import {
  buildBoundedEnv,
  runBounded,
  createBoundedExecutor,
  DEFAULT_MAX_OLD_SPACE_MB,
  DEFAULT_VITEST_MAX_THREADS,
} from '../../../src/verify/bounded-runner.js';

describe('Step 5.4: Resource-Bounded Sandboxed Test Runner', () => {
  it('buildBoundedEnv injects V8 max-old-space-size and VITEST_MAX_THREADS', () => {
    const env = buildBoundedEnv({ FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`);
    expect(env.VITEST_MAX_THREADS).toBe(String(DEFAULT_VITEST_MAX_THREADS));
  });

  it('buildBoundedEnv preserves existing NODE_OPTIONS when appending memory flag', () => {
    const env = buildBoundedEnv({ NODE_OPTIONS: '--enable-source-maps' });
    expect(env.NODE_OPTIONS).toBe(
      `--enable-source-maps --max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`,
    );
  });

  it('buildBoundedEnv respects existing max-old-space-size if present', () => {
    const env = buildBoundedEnv({ NODE_OPTIONS: '--max-old-space-size=1024' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=1024');
  });

  it('runs command with execFile without shell interpolation and returns output', async () => {
    const result = await runBounded(process.execPath, ['-e', 'console.log("bounded-ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('bounded-ok');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('terminates cleanly on timeout without hanging the process', async () => {
    const result = await runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('stops and rejects when buffer exceeds maxBufferBytes', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(10000))'],
      { maxBufferBytes: 500 },
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('createBoundedExecutor adapts to Executor interface', async () => {
    const exec = createBoundedExecutor();
    const res = await exec(`${process.execPath} -e console.log("via-adapter")`, {
      cwd: process.cwd(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe('via-adapter');
    expect(res.timedOut).toBe(false);
  });
});
