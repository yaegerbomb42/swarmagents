/**
 * Abstract interfaces and types for Omnexx sandbox runtimes (Step 8.4).
 */

export interface SandboxRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface SandboxRunOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface ISandboxRuntime {
  readonly kind: 'vm' | 'worktree' | 'container';
  isAvailable(): Promise<boolean>;
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  cleanup(): Promise<void>;
}
