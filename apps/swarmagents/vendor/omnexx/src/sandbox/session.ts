/**
 * Step 8.6 — Sandbox execution session & wiring.
 * Bridges agent loops and tool contexts to isolated sandbox runtimes (MicroVM,
 * Container, or Shadow Worktree) and PTY streams.
 */

import { PathJail } from '../security/paths.js';
import { assertPathInJail } from '../security/path-jail.js';
import { spawnPty, type PtyBridge, type PtyBridgeOptions } from './pty-bridge.js';
import type { ISandboxRuntime, SandboxRunOptions, SandboxRunResult } from './runtime/types.js';
import { provisionShadowWorkspace, type ShadowWorkspace } from './workspace-manager.js';

export interface SandboxSessionOptions {
  readonly workspaceRoot: string;
  readonly runtime?: ISandboxRuntime;
  readonly useShadow?: boolean;
}

export class SandboxSession {
  readonly jail: PathJail;
  readonly jailRoot: string;
  readonly runtime?: ISandboxRuntime;
  private readonly shadow?: ShadowWorkspace;
  private activePty: PtyBridge | null = null;
  private disposed = false;

  private constructor(jailRoot: string, runtime?: ISandboxRuntime, shadow?: ShadowWorkspace) {
    this.jailRoot = jailRoot;
    this.jail = new PathJail(jailRoot);
    if (runtime) {
      this.runtime = runtime;
    }
    if (shadow) {
      this.shadow = shadow;
    }
  }

  static async create(options: SandboxSessionOptions): Promise<SandboxSession> {
    if (options.useShadow) {
      const shadow = await provisionShadowWorkspace(options.workspaceRoot);
      return new SandboxSession(shadow.path, options.runtime, shadow);
    }
    return new SandboxSession(options.workspaceRoot, options.runtime);
  }

  /**
   * Asserts a path is contained strictly within this sandbox session's jail root.
   */
  assertPath(candidatePath: string, mode: 'read' | 'write' = 'write'): string {
    return assertPathInJail(candidatePath, this.jailRoot, { mode });
  }

  /**
   * Executes a command inside the sandbox runtime if available, or locally inside jailRoot.
   */
  async execute(options: SandboxRunOptions): Promise<SandboxRunResult> {
    if (this.disposed) {
      throw new Error('SandboxSession has been disposed');
    }
    if (this.runtime) {
      const isAvail = await this.runtime.isAvailable();
      if (isAvail) {
        return this.runtime.run({
          ...options,
          cwd: options.cwd ? this.assertPath(options.cwd) : this.jailRoot,
        });
      }
    }

    const bridgeOptions: PtyBridgeOptions = {
      command: options.command,
      ...(options.args ? { args: options.args } : {}),
      cwd: options.cwd ? this.assertPath(options.cwd) : this.jailRoot,
      ...(options.env ? { env: options.env } : {}),
    };

    const bridge = spawnPty(bridgeOptions);

    let stdout = '';
    bridge.onData((chunk) => {
      stdout += chunk;
    });

    const exitInfo = await bridge.waitForExit(options.timeoutMs ?? 60_000);
    return {
      exitCode: exitInfo.exitCode ?? 0,
      stdout,
      stderr: '',
      timedOut: exitInfo.exitCode === 124,
      durationMs: 0,
    };
  }

  /**
   * Spawns an interactive PTY bridge session strictly anchored to this sandbox root.
   */
  spawnPty(options: Partial<PtyBridgeOptions> = {}): PtyBridge {
    if (this.disposed) {
      throw new Error('SandboxSession has been disposed');
    }
    const defaultShell =
      process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    const bridgeOptions: PtyBridgeOptions = {
      command: options.command ?? defaultShell,
      ...(options.args ? { args: options.args } : {}),
      cwd: options.cwd ? this.assertPath(options.cwd) : this.jailRoot,
      ...(options.env ? { env: options.env } : {}),
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      name: options.name ?? 'Omnexx: Sandbox Session',
    };

    const pty = spawnPty(bridgeOptions);
    this.activePty = pty;
    return pty;
  }

  /**
   * Releases active PTY processes and tears down shadow workspace copies.
   */
  async cleanup(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activePty) {
      void this.activePty.dispose();
      this.activePty = null;
    }
    if (this.runtime) {
      await this.runtime.cleanup();
    }
    if (this.shadow) {
      await this.shadow.cleanup();
    }
  }
}
