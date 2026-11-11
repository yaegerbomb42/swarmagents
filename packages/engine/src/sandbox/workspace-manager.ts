/**
 * Step 8.4 — Workspace shadow provisioner.
 *
 * Provisions an isolated copy of a source tree that work can happen in without touching
 * the original, and guarantees idempotent cleanup — including on normal process exit via
 * a module-level `exit` hook (the `exit` event is the last synchronous moment a Node
 * process reliably offers; `SIGKILL` cannot be intercepted).
 */

import { rmSync } from 'node:fs';
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ShadowWorkspace {
  /** Absolute path to the shadow copy. */
  path: string;
  /** Idempotent removal of the shadow. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/** Shadow paths currently alive in this process, removed synchronously on exit. */
const active = new Set<string>();
let exitHookRegistered = false;

function ensureExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    try {
      cleanupAllShadowsSync();
    } catch {
      // best effort at the last synchronous moment
    }
  });
}

/**
 * Synchronous, idempotent removal of every registered shadow. Invoked by the process
 * `exit` hook; exported so the termination path is reachable/testable deterministically.
 */
export function cleanupAllShadowsSync(): void {
  for (const path of active) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // keep sweeping the remaining shadows
    }
  }
  active.clear();
}

/**
 * Provision a shadow workspace: a fresh temporary directory populated with a recursive
 * copy of `sourceRoot`. The returned `cleanup()` removes the shadow and is idempotent.
 *
 * @throws when `sourceRoot` does not exist or is not a directory.
 */
export async function provisionShadowWorkspace(sourceRoot: string): Promise<ShadowWorkspace> {
  const src = await realpath(sourceRoot).catch((cause: unknown) => {
    throw new Error(`shadow source does not exist: ${sourceRoot}`, { cause });
  });
  const srcStat = await stat(src);
  if (!srcStat.isDirectory()) {
    throw new Error(`shadow source is not a directory: ${sourceRoot}`);
  }

  const shadowPath = await mkdtemp(join(tmpdir(), 'omnexx-shadow-'));
  await cp(src, shadowPath, { recursive: true });

  active.add(shadowPath);
  ensureExitHook();

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    active.delete(shadowPath);
    await rm(shadowPath, { recursive: true, force: true }).catch(() => undefined);
  };

  return { path: shadowPath, cleanup };
}
