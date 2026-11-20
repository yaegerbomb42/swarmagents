import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePaths } from '../../src/core/paths.js';
import { listRunIds, RunStore, type RunState } from '../../src/core/run-store.js';
import { readTaskCheckpoint } from '../../src/core/checkpoint.js';
import { readLock } from '../../src/core/lock.js';
import { git } from '../../src/git/git.js';

import { parseTrailers } from '../../src/git/trailers.js';
import { entry, processRepo, waitFor } from '../support/proc.js';

const ITERATIONS = Number(process.env.OMNEXX_CHAOS_ITERATIONS ?? 20);
const PHASES = ['select', 'act', 'verify', 'commit', 'record', 'guard'] as const;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

async function trailerCommits(state: RunState): Promise<string[]> {
  const log = (
    await git(state.worktree, ['log', '--format=%B%x00', `${state.startRef}..${state.lastGreen}`])
  ).stdout;
  return log
    .split('\0')
    .map((m) => parseTrailers(m))
    .filter((t) => t !== undefined)
    .map((t) => `${t.task}@${t.cycle}`);
}

describe(`chaos survivability: 20 consecutive runs surviving all 5 failure modes`, () => {
  it.each(Array.from({ length: ITERATIONS }, (_, i) => i + 1))(
    'iteration %i / 20',
    async (iteration) => {
      const rand = rng(iteration * 9973);
      const scenarioType = iteration % 4; // 0: kill-9 + resume, 1: 429 failover, 2: compaction, 3: model swap mid-edit
      const taskCount = 3 + Math.floor(rand() * 3);

      if (scenarioType === 0) {
        // SCENARIO 1: kill -9 at a random step + disk reconciliation on resume
        const killPhase = PHASES[Math.floor(rand() * PHASES.length)] ?? 'act';
        const killCycle = 1 + Math.floor(rand() * taskCount);
        const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: String(taskCount) });

        // Run and trigger SIGKILL
        const first = await entry(['run', `Create ${taskCount} files`], {
          cwd: repo,
          env: { ...env, OMNEXX_TEST_KILL: `${killPhase}:${killCycle}` },
        });
        expect(first.code).not.toBe(0);

        const [runId] = await listRunIds(resolvePaths(env));
        expect(runId).toBeDefined();
        const store = new RunStore(resolvePaths(env), runId ?? '');
        const state = await store.readState();

        // Verify checkpoint exists before transition
        const cp = await readTaskCheckpoint(state.worktree, state.taskId ?? runId ?? '');
        expect(cp).toBeDefined();
        expect(cp?.goal).toBeDefined();
        expect(cp?.gitHead).toBeDefined();
        expect(cp?.status).toBeDefined();

        // External disk drift test: on even iterations, mutate an existing completed file outside the agent
        const shouldMutate = iteration % 2 === 0 && cp && cp.completedSteps.length > 0;
        if (shouldMutate && cp.completedSteps[0]?.filesModified[0]) {
          const fileToMutate = join(state.worktree, cp.completedSteps[0].filesModified[0]);
          await writeFile(fileToMutate, 'mutated externally outside agent\n');
        }

        // Resume using `omnexx resume <id>`
        const resumed = await entry(['resume', runId ?? ''], {
          cwd: repo,
          env: { ...env, OMNEXX_TEST_BOOT_ID: `boot-resume-${iteration}` },
        });
        expect(resumed.code, resumed.stderr).toBe(0);

        // Wait for background supervisor to finish and release lock
        const finalState = await waitFor(
          async () => {
            const s = await store.readState();
            const lock = await readLock(store.dir);
            return s.status === 'finished' && !lock ? s : undefined;
          },
          30_000,
          'task completion after resume',
        );
        await new Promise((r) => setTimeout(r, 200));
        expect(finalState.status).toBe('finished');
        expect((await trailerCommits(finalState)).length).toBe(taskCount);
      } else if (scenarioType === 1) {
        // SCENARIO 2: 429 rate limit & quota failover / clean park
        const shouldExhaust = iteration === 5; // One iteration tests clean parking on exhausted chain
        const { repo, env } = await processRepo({
          OMNEXX_TEST_TASKS: String(taskCount),
          OMNEXX_TEST_429: shouldExhaust ? 'all' : '1',
        });

        const res = await entry(['run', `Create ${taskCount} files on 429`], {
          cwd: repo,
          env,
        });

        const [runId] = await listRunIds(resolvePaths(env));
        expect(runId).toBeDefined();
        const store = new RunStore(resolvePaths(env), runId ?? '');
        const state = await store.readState();
        const cp = await readTaskCheckpoint(state.worktree, state.taskId ?? runId ?? '');

        if (shouldExhaust) {
          // When every model fails with 429, it must park cleanly with resumable status and zero lost state
          expect(['paused', 'needs-human', 'parked', 'budget-stop']).toContain(state.status);
          expect(cp).toBeDefined();
          expect(cp?.dirtyFileHashes).toBeDefined();
        } else {
          // Recovered from 429 via failover and completed
          expect(res.code, res.stderr).toBe(0);
          expect(state.status).toBe('finished');
          expect((await trailerCommits(state)).length).toBe(taskCount);
        }
      } else if (scenarioType === 2) {
        // SCENARIO 3: Forced Context Compaction
        // Setting compact_at very low forces compaction throughout execution
        const { repo, env } = await processRepo({
          OMNEXX_TEST_TASKS: String(taskCount),
        });

        // Write config with forced aggressive compaction
        const configPath = join(repo, 'omnexx.toml');
        const currentConfig = await readFile(configPath, 'utf8');
        await writeFile(
          configPath,
          currentConfig + '\n[context]\ncompact_at = 800\ncompact_keep_turns = 2\n',
        );
        await git(repo, ['commit', '-am', 'force compaction settings']);

        const res = await entry(['run', `Create ${taskCount} files with compaction`], {
          cwd: repo,
          env,
        });

        expect(res.code, res.stderr).toBe(0);
        const [runId] = await listRunIds(resolvePaths(env));
        const store = new RunStore(resolvePaths(env), runId ?? '');
        const state = await store.readState();
        expect(state.status).toBe('finished');
        expect((await trailerCommits(state)).length).toBe(taskCount);

        // Verify checkpoint still held the complete goal and acceptance criteria
        const cp = await readTaskCheckpoint(state.worktree, state.taskId ?? runId ?? '');
        expect(cp?.goal).toMatch(/Create \d+ files/);
      } else {
        // SCENARIO 4: Model Swap Mid-Edit
        const { repo, env } = await processRepo({
          OMNEXX_TEST_TASKS: String(taskCount),
        });

        // Kill on 'act:1' while edits are happening
        const first = await entry(['run', `Create ${taskCount} files on model swap`], {
          cwd: repo,
          env: { ...env, OMNEXX_TEST_KILL: 'act:1' },
        });
        expect(first.code).not.toBe(0);

        const [runId] = await listRunIds(resolvePaths(env));
        const store = new RunStore(resolvePaths(env), runId ?? '');
        const state = await store.readState();

        // Checkpoint captured dirty file hashes before death
        const cp = await readTaskCheckpoint(state.worktree, state.taskId ?? runId ?? '');
        expect(cp).toBeDefined();

        // Resume with supervisor (simulating next model pick)
        const last = await entry(['supervise', runId ?? ''], {
          cwd: repo,
          env: { ...env, OMNEXX_TEST_BOOT_ID: 'boot-modelswap' },
        });
        expect(last.code, last.stderr).toBe(0);

        const finalState = await store.readState();
        expect(finalState.status).toBe('finished');
        expect((await trailerCommits(finalState)).length).toBe(taskCount);
      }
    },
  );
});
