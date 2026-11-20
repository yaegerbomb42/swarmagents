/**
 * EvolutionGate — autonomous self-validation for the 24/7 self-evolution engine.
 *
 * Before Omnexx ships a self-improvement change, the change must prove the repo
 * still passes its own full check (default: `npm run typecheck && npm test`).
 * The check runs inside the isolated (transient) task worktree. If it fails:
 *
 *  - stale git lock files are cleared (`clearStaleGitLocks`),
 *  - the worktree is rolled back to the base commit (`rollbackTo`), and
 *  - the failure is appended to the repo's `autonomous_improvements.md`.
 *
 * The command runner is injectable so tests can drive pass/fail without ever
 * invoking npm. Defaults to a shell runner with a hard timeout.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { clearStaleGitLocks } from '../git/locks.js';
import { rollbackTo } from '../git/rollback.js';

export interface EvolutionCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type EvolutionCommandRunner = (
  cwd: string,
  command: string,
  opts?: { timeoutMs?: number },
) => Promise<EvolutionCommandResult>;

export const DEFAULT_EVOLUTION_COMMAND = 'npm run typecheck && npm test';

/** Default runner: shell with a strict timeout; never throws on non-zero exit. */
export const defaultEvolutionRunner: EvolutionCommandRunner = async (cwd, command, opts) => {
  const r = await execa(command, {
    cwd,
    shell: true,
    reject: false,
    ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
};

export interface EvolutionGateOptions {
  /** Main checkout the improvement targets; default improvements path derives from it. */
  repoRoot: string;
  /** Commit to roll back to on failure (the task's base SHA). */
  baseSha: string;
  /** Where failures are recorded; defaults to `<repoRoot>/autonomous_improvements.md`. */
  improvementsPath?: string;
  /** The exact self-validation command. Defaults to `npm run typecheck && npm test`. */
  command?: string;
  /** Hard timeout (ms) for the whole gate. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Test seam: command runner. Defaults to `defaultEvolutionRunner`. */
  run?: EvolutionCommandRunner;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface EvolutionGateResult {
  ok: boolean;
  diagnostics: string[];
  /** True when the gate failure triggered a rollback of the worktree. */
  rolledBack: boolean;
}

export interface EvolutionFailureEntry {
  /** ISO timestamp. */
  at: string;
  taskId?: string;
  command: string;
  exitCode?: number;
  stderr: string;
}

export const DEFAULT_IMPROVEMENTS_FILE = 'autonomous_improvements.md';

/** Append a markdown failure entry to the improvements log. */
export async function recordEvolutionFailure(
  path: string,
  entry: EvolutionFailureEntry,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    '',
    `## 🔴 Evolution gate failed @ ${entry.at}`,
    ...(entry.taskId ? [`- Task: \`${entry.taskId}\``] : []),
    `- Command: \`${entry.command}\``,
    ...(entry.exitCode !== undefined ? [`- Exit code: ${entry.exitCode}`] : []),
    entry.stderr.trim()
      ? ['- Output:', '', '```', entry.stderr.trim().slice(0, 4000), '```']
      : ['- Output: *(none)*'],
    '',
  ].flat();
  await appendFile(path, lines.join('\n'), 'utf8');
}

/**
 * Run the evolution gate in the (transient) task worktree. Returns `{ok:true}`
 * when the self-validation command passes. On failure, clears stale locks, rolls
 * the worktree back to `baseSha`, and records the failure — then returns
 * `{ok:false}` with diagnostics. Never throws.
 */
export async function runEvolutionGate(
  worktree: string,
  options: EvolutionGateOptions,
): Promise<EvolutionGateResult> {
  const command = options.command ?? DEFAULT_EVOLUTION_COMMAND;
  const run = options.run ?? defaultEvolutionRunner;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const improvementsPath =
    options.improvementsPath ?? join(options.repoRoot, DEFAULT_IMPROVEMENTS_FILE);
  const diagnostics: string[] = [];

  let failed: { exitCode?: number; output: string } | undefined;
  let crashed = false;
  try {
    const res = await run(worktree, command, { timeoutMs });
    if (res.exitCode === 0) return { ok: true, diagnostics: [], rolledBack: false };
    failed = { exitCode: res.exitCode, output: res.stderr };
    diagnostics.push(`\`${command}\` exited ${res.exitCode}`);
  } catch (err) {
    crashed = true;
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(`evolution command failed: ${message}`);
    failed = { output: message };
  }

  // Rollback path: clear stale locks, restore the worktree to base, record.
  await clearStaleGitLocks(worktree).catch(() => undefined);
  let rolledBack = false;
  try {
    await rollbackTo(worktree, options.baseSha);
    rolledBack = true;
  } catch (err) {
    diagnostics.push(`rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry: EvolutionFailureEntry = {
    at: new Date().toISOString(),
    command,
    stderr: failed.output.trim().slice(0, 4000) || (crashed ? 'command did not run' : ''),
  };
  if (!crashed && failed.exitCode !== undefined) entry.exitCode = failed.exitCode;
  try {
    await recordEvolutionFailure(improvementsPath, entry);
  } catch (err) {
    diagnostics.push(
      `failed to record evolution failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { ok: false, diagnostics, rolledBack };
}
