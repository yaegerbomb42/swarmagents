/**
 * Apple Silicon / Lima & Colima MicroVM Runtime (Step 8.4).
 * Provides hypervisor-isolated sandbox execution on macOS with fallback to container/worktree.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ISandboxRuntime, SandboxRunOptions, SandboxRunResult } from './types.js';

const execFileAsync = promisify(execFile);

export class VmUnavailableError extends Error {
  constructor(message = 'MicroVM runtime is unavailable') {
    super(message);
    this.name = 'VmUnavailableError';
  }
}

export type RunBinary = (argv: readonly string[]) => Promise<SandboxRunResult>;

export interface VmProbeResult {
  readonly available: boolean;
  readonly driver?: 'colima' | 'lima';
  readonly instance: string;
  readonly reason?: string;
}

export type VmProbe = () => Promise<VmProbeResult>;

export function formatColimaExec(command: string, args: readonly string[] = []): string[] {
  return ['colima', 'ssh', '--', command, ...args];
}

export function formatLimactlExec(
  instance: string,
  command: string,
  args: readonly string[] = [],
): string[] {
  return ['limactl', 'shell', instance, '--', command, ...args];
}

async function defaultRunBinary(argv: readonly string[]): Promise<SandboxRunResult> {
  const binary = argv[0];
  if (!binary) {
    throw new Error('Empty argv passed to runBinary');
  }
  const args = argv.slice(1);
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { encoding: 'utf8' });
    return {
      exitCode: 0,
      stdout,
      stderr,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const error = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(err),
      timedOut: Boolean(error.killed),
      durationMs: Date.now() - start,
    };
  }
}

async function defaultProbe(): Promise<VmProbeResult> {
  try {
    const { stdout } = await execFileAsync('colima', ['status'], { encoding: 'utf8' });
    if (stdout.includes('colima is running')) {
      return { available: true, driver: 'colima', instance: 'default' };
    }
    return { available: false, instance: 'default', reason: 'colima is not running' };
  } catch {
    return { available: false, instance: 'default', reason: 'colima binary not found or error' };
  }
}

export interface VmRuntimeOptions {
  readonly runBinary?: RunBinary;
  readonly probe?: VmProbe;
  readonly fallback?: ISandboxRuntime;
  readonly driver?: 'colima' | 'lima';
  readonly instance?: string;
}

export class VmRuntime implements ISandboxRuntime {
  readonly kind = 'vm' as const;
  private readonly runBinary: RunBinary;
  private readonly probe: VmProbe;
  private readonly fallback: ISandboxRuntime | undefined;
  private readonly driver: 'colima' | 'lima';
  private readonly instance: string;

  constructor(options: VmRuntimeOptions = {}) {
    this.runBinary = options.runBinary ?? defaultRunBinary;
    this.probe = options.probe ?? defaultProbe;
    this.fallback = options.fallback;
    this.driver = options.driver ?? 'colima';
    this.instance = options.instance ?? 'default';
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.probe();
    return result.available;
  }

  async run(options: SandboxRunOptions): Promise<SandboxRunResult> {
    const probeResult = await this.probe();
    if (!probeResult.available) {
      if (this.fallback) {
        return this.fallback.run(options);
      }
      throw new VmUnavailableError(probeResult.reason ?? 'MicroVM runtime is unavailable');
    }

    const effectiveDriver = probeResult.driver ?? this.driver;
    const effectiveInstance = probeResult.instance || this.instance;
    const argv =
      effectiveDriver === 'colima'
        ? formatColimaExec(options.command, options.args ?? [])
        : formatLimactlExec(effectiveInstance, options.command, options.args ?? []);

    return this.runBinary(argv);
  }

  async cleanup(): Promise<void> {
    if (this.fallback) {
      await this.fallback.cleanup();
    }
  }
}
