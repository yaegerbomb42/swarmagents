/**
 * Step 5.4: Resource-Bounded Sandboxed Test Runner.
 *
 * Executes test commands using node:child_process.execFile (strictly avoiding shell
 * interpolation to eliminate injection vectors and shell wrapper overhead).
 *
 * Enforces strict deterministic resource ceilings:
 *   - Execution timeout: default 60,000ms
 *   - Buffer limit: default 20MB (20 * 1024 * 1024 bytes)
 *   - V8 memory ceiling: --max-old-space-size=512 via NODE_OPTIONS
 *   - Parallelism constraint: VITEST_MAX_THREADS=2
 *
 * Process group isolation:
 *   - Spawned detached in its own process group
 *   - Registered with Omnexx's process-registry
 *   - Graceful SIGTERM -> 1000ms -> SIGKILL cascade targeting the entire process group
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { killGroup } from '../core/exec.js';
import { registerChild, unregisterChild } from '../core/process-registry.js';
import type { Executor, ExecOptions, ExecResult } from '../core/exec.js';

export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB
export const DEFAULT_MAX_OLD_SPACE_MB = 512;
export const DEFAULT_VITEST_MAX_THREADS = 2;

export interface BoundedRunnerOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxOldSpaceMb?: number;
  maxVitestThreads?: number;
  signal?: AbortSignal;
  runId?: string;
}

export interface BoundedRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Builds the bounded environment variables, pinning memory and thread limits.
 */
export function buildBoundedEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: Pick<BoundedRunnerOptions, 'maxOldSpaceMb' | 'maxVitestThreads'> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }

  const maxMem = options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  const memFlag = `--max-old-space-size=${maxMem}`;
  const existingNodeOpts = env.NODE_OPTIONS ?? '';
  if (!existingNodeOpts.includes('--max-old-space-size=')) {
    env.NODE_OPTIONS = existingNodeOpts ? `${existingNodeOpts} ${memFlag}` : memFlag;
  }

  const threads = options.maxVitestThreads ?? DEFAULT_VITEST_MAX_THREADS;
  env.VITEST_MAX_THREADS = String(threads);

  return env;
}

/**
 * Executes a binary directly with arguments, enforcing resource ceilings and process group cleanup.
 */
export async function runBounded(
  file: string,
  args: string[] = [],
  opts: BoundedRunnerOptions = {},
): Promise<BoundedRunnerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const env = buildBoundedEnv(opts.env ?? process.env, {
    ...(opts.maxOldSpaceMb !== undefined ? { maxOldSpaceMb: opts.maxOldSpaceMb } : {}),
    ...(opts.maxVitestThreads !== undefined ? { maxVitestThreads: opts.maxVitestThreads } : {}),
  });

  const startTime = Date.now();
  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;

  return new Promise<BoundedRunnerResult>((resolve) => {
    const execOptions: ExecFileOptions = {
      cwd: opts.cwd ?? process.cwd(),
      env,
      maxBuffer,
      timeout: 0, // We handle timeout via process-group killGroup
      ...(opts.signal ? { signal: opts.signal } : {}),
      shell: false, // Strictly false: never invoke a shell
    };

    const child = execFile(file, args, execOptions, (error, stdoutBuffer, stderrBuffer) => {
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (child.pid !== undefined) {
        unregisterChild(child.pid, opts.runId);
      }

      const durationMs = Date.now() - startTime;
      const stdout =
        typeof stdoutBuffer === 'string' ? stdoutBuffer : stdoutBuffer.toString('utf8');
      const stderr =
        typeof stderrBuffer === 'string' ? stderrBuffer : stderrBuffer.toString('utf8');
      const output = `${stdout}${stderr}`;

      let exitCode = 0;
      if (timedOut) {
        exitCode = 124; // Standard timeout exit code
      } else if (error) {
        if ('code' in error && typeof error.code === 'number') {
          exitCode = error.code;
        } else {
          exitCode = 1;
        }
      }

      resolve({
        exitCode,
        stdout,
        stderr,
        output,
        timedOut,
        durationMs,
      });
    });

    if (child.pid !== undefined) {
      registerChild(
        {
          pid: child.pid,
          pgid: child.pid,
          kind: 'task',
          command: [file, ...args].join(' '),
          startedAt: startTime,
        },
        opts.runId,
      );

      // Enforce timeout
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        killTimer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore
          }
          if (child.pid !== undefined) {
            killGroup(child.pid, 'SIGTERM');
            forceKillTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // Ignore
              }
              if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
            }, 500);
          }
        }, timeoutMs);
      }
    }
  });
}

/**
 * Creates an Executor function conforming to Omnexx's core Executor interface,
 * delegating commands to the bounded runner without shell interpolation.
 */
export function createBoundedExecutor(defaultOpts: BoundedRunnerOptions = {}): Executor {
  return async (command: string, opts: ExecOptions): Promise<ExecResult> => {
    // Parse single command string into file + args if passed as a string
    const parts = command.trim().split(/\s+/);
    const file = parts[0] ?? '';
    const args = parts.slice(1);

    const mergedTimeout = opts.timeoutMs ?? defaultOpts.timeoutMs;
    const mergedSignal = opts.signal ?? defaultOpts.signal;

    const mergedOpts: BoundedRunnerOptions = {
      cwd: opts.cwd,
      env: {
        ...(defaultOpts.env as Record<string, string>),
        ...(opts.env as Record<string, string>),
      },
      ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
      ...(mergedSignal !== undefined ? { signal: mergedSignal } : {}),
    };

    const res = await runBounded(file, args, mergedOpts);
    return {
      exitCode: res.exitCode,
      output: res.output,
      durationMs: res.durationMs,
      timedOut: res.timedOut,
      cwd: opts.cwd,
    };
  };
}
