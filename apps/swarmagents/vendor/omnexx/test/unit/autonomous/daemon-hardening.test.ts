/**
 * Subsystem 8 — Spot24/7 Autonomous Self-Evolution Engine hardening.
 *
 * Covers the three goals:
 *   1. Loop termination & early-stop clean exit: `AutonomousDaemon.start`/`stop`
 *      resolve cleanly and release the daemon lock (no lingering state).
 *   2. Autonomous self-validation (evolution gate): `runEvolutionGate` runs the
 *      repo's full check in the transient/task worktree; on failure it clears
 *      stale git locks, rolls the worktree back to base, and records the failure
 *      in `autonomous_improvements.md`.
 *   3. Health heartbeat & circuit-breaker backoff: `failureBackoffMs` escalates
 *      sleep after consecutive failures and is capped.
 */
import { existsSync } from 'node:fs';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutonomousDaemon, isOmnexxRepo } from '../../../src/autonomous/daemon.js';
import { failureBackoffMs } from '../../../src/autonomous/daemon.js';
import {
  DEFAULT_EVOLUTION_COMMAND,
  recordEvolutionFailure,
  runEvolutionGate,
  type EvolutionCommandRunner,
} from '../../../src/autonomous/evolution-gate.js';
import { AutonomousStateStore } from '../../../src/autonomous/state-store.js';
import { git } from '../../../src/git/git.js';
import { gitDirFor } from '../../../src/git/locks.js';
import { tempDir, tempRepo } from '../../support/tmp.js';
import { FakeClock } from '../../support/clock.js';

async function seededRepo(): Promise<{ repo: string; head: string }> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { repo, head };
}

const failingRunner: EvolutionCommandRunner = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: 'typecheck failed: src/foo.ts(1,1): error TS2322',
});

const passingRunner: EvolutionCommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

describe('evolution gate (autonomous self-validation)', () => {
  it('passes and records nothing when the full check succeeds', async () => {
    const { repo, head } = await seededRepo();
    const improvementsPath = join(await tempDir(), 'autonomous_improvements.md');

    const result = await runEvolutionGate(repo, {
      repoRoot: repo,
      baseSha: head,
      improvementsPath,
      run: passingRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(existsSync(improvementsPath)).toBe(false);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('rolls back, clears stale locks, and records the failure when the check fails', async () => {
    const { repo, head } = await seededRepo();
    const improvementsPath = join(await tempDir(), 'autonomous_improvements.md');

    // Simulate a speculative change that failed validation.
    await writeFile(join(repo, 'a.txt'), 'broken\n');

    // Plant a stale index.lock so we can prove lock clearance fires.
    const lock = join(await gitDirFor(repo), 'index.lock');
    await writeFile(lock, '');
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);

    const result = await runEvolutionGate(repo, {
      repoRoot: repo,
      baseSha: head,
      improvementsPath,
      run: failingRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/exited 1/);
    // Rollback restored the worktree byte-identically.
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    // Stale git lock was cleared.
    expect(existsSync(lock)).toBe(false);
    // Failure was recorded in autonomous_improvements.md.
    const recorded = await readFile(improvementsPath, 'utf8');
    expect(recorded).toContain('Evolution gate failed');
    expect(recorded).toContain(DEFAULT_EVOLUTION_COMMAND);
    expect(recorded).toMatch(/Exit code: 1/);
  });

  it('still records a hard runner crash and returns ok=false, trying rollback', async () => {
    const { repo, head } = await seededRepo();
    const improvementsPath = join(await tempDir(), 'autonomous_improvements.md');
    await writeFile(join(repo, 'a.txt'), 'broken\n');
    const crashRunner: EvolutionCommandRunner = async () => {
      throw new Error('spawn npm ENOENT');
    };

    const result = await runEvolutionGate(repo, {
      repoRoot: repo,
      baseSha: head,
      improvementsPath,
      run: crashRunner,
    });

    expect(result.ok).toBe(false);
    // A crashed runner means we do not know the exit code, but we still roll back
    // and record the failure so the fact is not lost.
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(improvementsPath, 'utf8')).toContain('Evolution gate failed');
  });

  it('recordEvolutionFailure appends idempotently with mkdir of the parent', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'autonomous_improvements.md');
    await recordEvolutionFailure(path, {
      at: '2026-11-09T00:00:00.000Z',
      taskId: 't_x',
      command: 'npm run typecheck && npm test',
      exitCode: 2,
      stderr: 'boom',
    });
    await recordEvolutionFailure(path, {
      at: '2026-11-09T00:00:01.000Z',
      command: 'npm test',
      stderr: '',
    });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('t_x');
    expect(text).toContain('Exit code: 2');
    expect((text.match(/Evolution gate failed/g) ?? []).length).toBe(2);
  });
});

describe('health heartbeat / circuit-breaker backoff', () => {
  it('returns 0 below or at the failure threshold', () => {
    expect(failureBackoffMs(1, 3, 30_000, 3_600_000)).toBe(0);
    expect(failureBackoffMs(3, 3, 30_000, 3_600_000)).toBe(0);
  });

  it('escalates from the base after the threshold', () => {
    expect(failureBackoffMs(4, 3, 30_000, 3_600_000)).toBe(30_000);
    expect(failureBackoffMs(5, 3, 30_000, 3_600_000)).toBe(60_000);
    expect(failureBackoffMs(7, 3, 30_000, 3_600_000)).toBe(240_000);
  });

  it('caps at the maximum backoff', () => {
    expect(failureBackoffMs(100, 3, 30_000, 3_600_000)).toBe(3_600_000);
  });
});

describe('isOmnexxRepo (evolution gate scope)', () => {
  it('detects the Omnexx repo by package.json name', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'omnexx' }));
    expect(await isOmnexxRepo(repo)).toBe(true);
  });

  it('returns false for a generic repo or absent package.json', async () => {
    const generic = await tempRepo();
    await writeFile(join(generic, 'package.json'), JSON.stringify({ name: 'some-other-tool' }));
    expect(await isOmnexxRepo(generic)).toBe(false);

    const bare = await tempRepo();
    expect(await isOmnexxRepo(bare)).toBe(false);
  });
});

describe('daemon loop termination & clean exit', () => {
  it('start(maxCycles) resolves, stops running, and releases the daemon lock', async () => {
    const repo = await tempRepo();
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: ':memory:' });
    const daemon = new AutonomousDaemon({
      repoRoot: repo,
      store,
      clock: new FakeClock(),
      idleSleepBaseMs: 10,
      headPollMs: 10,
    });

    await daemon.start({ maxCycles: 1 });

    expect(daemon.isRunning).toBe(false);
    expect(existsSync(join(repo, '.omnexx', 'daemon.lock'))).toBe(false);
    // Stop is idempotent after a clean exit.
    await daemon.stop();
  });

  it('stop() aborts an idle loop and releases the lock without hanging', async () => {
    const repo = await tempRepo();
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: ':memory:' });
    const daemon = new AutonomousDaemon({
      repoRoot: repo,
      store,
      clock: new FakeClock(),
      idleSleepBaseMs: 10,
      headPollMs: 10,
      shutdownGraceMs: 500,
    });

    const running = daemon.start(); // no maxCycles → runs until stopped
    await daemon.stop();
    await running;

    expect(daemon.isRunning).toBe(false);
    expect(existsSync(join(repo, '.omnexx', 'daemon.lock'))).toBe(false);
  });
});
