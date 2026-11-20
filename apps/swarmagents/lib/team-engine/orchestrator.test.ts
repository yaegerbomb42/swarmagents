import { describe, expect, it } from '../testing/vitest-compat';
import {
  MemoryStore,
  TeamOrchestrator,
  type AgentRunner,
  type AgentRunRequest,
  type AgentStreamEvent,
  type Clock,
  type Store,
  type TeamRunState,
} from './index';

class FakeClock implements Clock {
  private current = 1_700_000_000_000;

  now(): number {
    this.current += 100;
    return this.current;
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeRunner(
  handler: (req: AgentRunRequest) => AsyncGenerator<AgentStreamEvent, void, void>,
): AgentRunner {
  return {
    start(req: AgentRunRequest): AsyncIterable<AgentStreamEvent> {
      return handler(req);
    },
  };
}

describe('TeamOrchestrator', () => {
  it('1. happy path: 4 tasks with DAG dependencies, isolated workdirs, merge conflict detection, and deterministic event log', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const recordedRequests: AgentRunRequest[] = [];

    const runner = makeFakeRunner(async function* (req) {
      recordedRequests.push(req);

      if (req.role === 'planner') {
        yield { type: 'thinking', content: 'Designing 4-task DAG', tokens: 50, costUsd: 0.01 };
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 't1',
                title: 'Setup core schema',
                description: 'Create base types',
                dependsOn: [],
                suggestedRole: 'architect',
                acceptanceCriteria: ['Types compile cleanly'],
              },
              {
                id: 't2',
                title: 'Implement auth service',
                description: 'Add auth handlers',
                dependsOn: ['t1'],
                suggestedRole: 'backend',
                acceptanceCriteria: ['Auth service passes unit tests'],
              },
              {
                id: 't3',
                title: 'Implement billing service',
                description: 'Add billing handlers',
                dependsOn: ['t1'],
                suggestedRole: 'backend',
                acceptanceCriteria: ['Billing service passes unit tests'],
              },
              {
                id: 't4',
                title: 'Integration test suite',
                description: 'Verify end-to-end flow',
                dependsOn: ['t2', 't3'],
                suggestedRole: 'tester',
                acceptanceCriteria: ['All integration tests green'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 120, costUsd: 0.02 };
        return;
      }

      if (req.role === 'reviewer') {
        yield {
          type: 'result',
          output: JSON.stringify({
            verdict: 'accept',
            feedback: 'Looks solid',
            conflictsResolved: true,
          }),
        };
        yield { type: 'done', tokens: 40, costUsd: 0.005 };
        return;
      }

      // Worker tasks
      const filesByTask: Record<string, string[]> = {
        t1: ['src/schema.ts'],
        t2: ['src/auth.ts', 'src/routes.ts'],
        t3: ['src/billing.ts', 'src/routes.ts'], // overlaps with t2 on src/routes.ts
        t4: ['tests/e2e.test.ts'],
      };

      yield { type: 'tool', name: 'write_file', input: req.taskId, tokens: 30, costUsd: 0.003 };
      yield {
        type: 'result',
        output: `Completed ${req.taskId}`,
        changedFiles: filesByTask[req.taskId ?? ''] ?? [],
      };
      yield { type: 'done', tokens: 100, costUsd: 0.01 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store }, { maxConcurrency: 2 });

    const finalState = await orchestrator.run({
      runId: 'run-happy-1',
      goal: 'Build auth and billing services',
      baseWorkdir: '/workspace/project',
      budget: { maxTokens: 10_000, maxCostUsd: 5.0 },
    });

    expect(finalState.status).toBe('completed');
    expect(finalState.tasks.map((t) => t.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);

    // Verify each worker ran in its own isolated workdir
    const workerRequests = recordedRequests.filter(
      (r) => r.role !== 'planner' && r.role !== 'reviewer',
    );
    expect(workerRequests).toHaveLength(4);
    expect(workerRequests.map((r) => r.workdir)).toEqual([
      '/workspace/project/tasks/t1',
      '/workspace/project/tasks/t2',
      '/workspace/project/tasks/t3',
      '/workspace/project/tasks/t4',
    ]);

    // Verify DAG ordering: t1 started before t2 & t3, and t4 started after both t2 & t3 completed
    const startedIds = finalState.events
      .filter((e) => e.type === 'task.started')
      .map((e) => e.taskId);
    expect(startedIds[0]).toBe('t1');
    expect(startedIds[3]).toBe('t4');

    // Verify merge conflict detection on src/routes.ts
    expect(finalState.mergeSummary?.conflicts).toEqual([
      {
        path: 'src/routes.ts',
        otherTaskIds: ['t2', 't3'],
      },
    ]);

    // Verify reviewer prompt received merge conflict alert for src/routes.ts
    const conflictReviewPrompts = recordedRequests.filter(
      (r) => r.role === 'reviewer' && r.prompt.includes('MERGE CONFLICT ALERT') && r.prompt.includes('src/routes.ts'),
    );
    expect(conflictReviewPrompts.length).toBeGreaterThanOrEqual(1);

    // Verify deterministic monotonic event sequence
    expect(finalState.events.map((e) => e.seq)).toEqual(
      finalState.events.map((_, idx) => idx + 1),
    );
    const doneEvent = finalState.events.at(-1);
    expect(doneEvent?.type).toBe('team.done');
  });

  it('2. respects per-user maxConcurrency cap across ready parallel tasks', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();

    let activeWorkers = 0;
    let maxObservedConcurrency = 0;
    const gates = new Map<string, ReturnType<typeof createDeferred<void>>>([
      ['t1', createDeferred()],
      ['t2', createDeferred()],
      ['t3', createDeferred()],
      ['t4', createDeferred()],
    ]);

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: ['t1', 't2', 't3', 't4'].map((id) => ({
              id,
              title: `Parallel task ${id}`,
              description: `Work ${id}`,
              dependsOn: [],
              suggestedRole: 'worker',
              acceptanceCriteria: ['Done'],
            })),
          }),
        };
        yield { type: 'done', tokens: 50, costUsd: 0.01 };
        return;
      }

      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 20, costUsd: 0.005 };
        return;
      }

      activeWorkers += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeWorkers);

      // Hold first two tasks until both are simultaneously in-flight
      if (activeWorkers === 2) {
        gates.get('t1')?.resolve();
        gates.get('t2')?.resolve();
      }
      if (req.taskId === 't3' || req.taskId === 't4') {
        gates.get(req.taskId)?.resolve();
      }

      await gates.get(req.taskId!)?.promise;
      activeWorkers -= 1;

      yield { type: 'result', output: `ok ${req.taskId}` };
      yield { type: 'done', tokens: 30, costUsd: 0.005 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store }, { maxConcurrency: 2 });

    const finalState = await orchestrator.run({
      runId: 'run-concurrency',
      goal: 'Run 4 parallel jobs with cap 2',
      baseWorkdir: '/work',
      budget: { maxTokens: 5000, maxCostUsd: 2 },
    });

    expect(finalState.status).toBe('completed');
    expect(maxObservedConcurrency).toBe(2);
  });

  it('3. sends rejected task back with specific reviewer feedback and accepts on retry', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const workerPrompts: string[] = [];
    let reviewCount = 0;

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 't1',
                title: 'Write parser',
                description: 'Parse config files',
                dependsOn: [],
                suggestedRole: 'engineer',
                acceptanceCriteria: ['Handles empty input gracefully'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 40, costUsd: 0.01 };
        return;
      }

      if (req.role === 'reviewer') {
        reviewCount += 1;
        if (reviewCount === 1) {
          yield {
            type: 'result',
            output: JSON.stringify({
              verdict: 'reject',
              feedback: 'Crashes when input string is empty; add guard clause.',
            }),
          };
        } else {
          yield {
            type: 'result',
            output: JSON.stringify({
              verdict: 'accept',
              feedback: 'Empty input guard verified.',
            }),
          };
        }
        yield { type: 'done', tokens: 25, costUsd: 0.005 };
        return;
      }

      workerPrompts.push(req.prompt);
      yield {
        type: 'result',
        output: req.attempt === 1 ? 'v1 without empty guard' : 'v2 with empty guard',
        changedFiles: ['src/parser.ts'],
      };
      yield { type: 'done', tokens: 60, costUsd: 0.01 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store });

    const finalState = await orchestrator.run({
      runId: 'run-retry-accept',
      goal: 'Implement config parser',
      baseWorkdir: '/work',
      budget: { maxTokens: 5000, maxCostUsd: 2 },
    });

    expect(finalState.status).toBe('completed');
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain('Crashes when input string is empty; add guard clause.');

    const eventTypes = finalState.events.map((e) => e.type);
    expect(eventTypes).toEqual([
      'team.plan',
      'task.started',
      'task.review',
      'task.retry',
      'task.started',
      'task.review',
      'team.done',
    ]);

    const retryEvent = finalState.events.find((e) => e.type === 'task.retry');
    expect(retryEvent).toMatchObject({
      type: 'task.retry',
      taskId: 't1',
      nextAttempt: 2,
      reason: 'Crashes when input string is empty; add guard clause.',
    });
  });

  it('4. marks task failed after 2 retries (3 total attempts) and replans dependents', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    let plannerCalls = 0;

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          yield {
            type: 'result',
            output: JSON.stringify({
              tasks: [
                {
                  id: 't1',
                  title: 'Fetch primary dataset',
                  description: 'Download dataset A',
                  dependsOn: [],
                  suggestedRole: 'data',
                  acceptanceCriteria: ['Dataset A ready'],
                },
                {
                  id: 't2',
                  title: 'Train GPU model',
                  description: 'Train neural model on GPU',
                  dependsOn: ['t1'],
                  suggestedRole: 'ml',
                  acceptanceCriteria: ['Accuracy > 90%'],
                },
                {
                  id: 't3',
                  title: 'Build statistical baseline',
                  description: 'Train fast linear model',
                  dependsOn: ['t1'],
                  suggestedRole: 'ml',
                  acceptanceCriteria: ['Baseline metrics saved'],
                },
                {
                  id: 't4',
                  title: 'Publish GPU model report',
                  description: 'Compare GPU model vs baseline',
                  dependsOn: ['t2', 't3'],
                  suggestedRole: 'analyst',
                  acceptanceCriteria: ['Final report published'],
                },
              ],
            }),
          };
        } else {
          // Replan triggered when t2 fails -> replaces dependent t4 with t5 depending only on t3
          expect(req.prompt).toContain('Failed Task:');
          expect(req.prompt).toContain('t2');
          expect(req.prompt).toContain('t4');

          yield {
            type: 'result',
            output: JSON.stringify({
              tasks: [
                {
                  id: 't5',
                  title: 'Publish baseline-only report',
                  description: 'Publish report using statistical baseline after GPU training failed',
                  dependsOn: ['t3'],
                  suggestedRole: 'analyst',
                  acceptanceCriteria: ['Baseline report published'],
                },
              ],
            }),
          };
        }
        yield { type: 'done', tokens: 80, costUsd: 0.01 };
        return;
      }

      if (req.role === 'reviewer') {
        // Always reject t2 so it exhausts initial + 2 retries
        if (req.taskId === 't2') {
          yield {
            type: 'result',
            output: JSON.stringify({
              verdict: 'reject',
              feedback: 'GPU out-of-memory error persists',
            }),
          };
        } else {
          yield {
            type: 'result',
            output: JSON.stringify({ verdict: 'accept' }),
          };
        }
        yield { type: 'done', tokens: 20, costUsd: 0.005 };
        return;
      }

      yield { type: 'result', output: `Output for ${req.taskId} attempt ${req.attempt}` };
      yield { type: 'done', tokens: 50, costUsd: 0.01 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store }, { maxConcurrency: 2 });

    const finalState = await orchestrator.run({
      runId: 'run-replan',
      goal: 'Train and evaluate predictive model',
      baseWorkdir: '/work',
      budget: { maxTokens: 10_000, maxCostUsd: 5 },
    });

    expect(finalState.status).toBe('completed');
    expect(plannerCalls).toBe(2);

    const taskById = new Map(finalState.tasks.map((t) => [t.id, t]));
    expect(taskById.get('t1')?.status).toBe('completed');
    expect(taskById.get('t2')?.status).toBe('failed');
    expect(taskById.get('t2')?.attempts).toBe(3);
    expect(taskById.get('t3')?.status).toBe('completed');
    expect(taskById.get('t4')?.status).toBe('superseded');
    expect(taskById.get('t5')?.status).toBe('completed');

    const failedEvents = finalState.events.filter((e) => e.type === 'task.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      type: 'task.failed',
      taskId: 't2',
      attempts: 3,
    });

    const planEvents = finalState.events.filter((e) => e.type === 'team.plan');
    expect(planEvents).toHaveLength(2);
    expect(planEvents[1]).toMatchObject({
      type: 'team.plan',
      isReplan: true,
      triggeredByTaskId: 't2',
    });
  });

  it('5. gracefully stops mid-run when global token or USD budget is exhausted', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    let secondTaskAborted = false;

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 't1',
                title: 'First step',
                description: 'Step 1',
                dependsOn: [],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
              {
                id: 't2',
                title: 'Expensive step',
                description: 'Step 2',
                dependsOn: ['t1'],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
              {
                id: 't3',
                title: 'Never reached step',
                description: 'Step 3',
                dependsOn: ['t2'],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 100, costUsd: 0.1 };
        return;
      }

      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 50, costUsd: 0.05 };
        return;
      }

      if (req.taskId === 't1') {
        yield { type: 'result', output: 't1 done' };
        yield { type: 'done', tokens: 100, costUsd: 0.1 };
        return;
      }

      // t2 streams tokens that push cumulative usage past maxTokens (300) mid-stream
      // The orchestrator aborts the signal and then stops iterating (which
      // calls return() on this generator), so observe the abort in finally.
      try {
        yield { type: 'thinking', content: 'Heavy reasoning...', tokens: 80, costUsd: 0.2 };
        yield { type: 'result', output: 't2 done' };
        yield { type: 'done', tokens: 100, costUsd: 0.25 };
      } finally {
        if (req.signal.aborted) secondTaskAborted = true;
      }
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store });

    const finalState = await orchestrator.run({
      runId: 'run-budget',
      goal: 'Budget-constrained goal',
      baseWorkdir: '/work',
      budget: { maxTokens: 300, maxCostUsd: 1.0 },
    });

    expect(finalState.status).toBe('budget_exceeded');
    expect(secondTaskAborted).toBe(true);
    expect(finalState.usage.totalTokens).toBeGreaterThanOrEqual(300);

    const taskById = new Map(finalState.tasks.map((t) => [t.id, t]));
    expect(taskById.get('t1')?.status).toBe('completed');
    expect(taskById.get('t2')?.status).toBe('pending');
    expect(taskById.get('t3')?.status).toBe('pending');

    const doneEvent = finalState.events.at(-1);
    expect(doneEvent).toMatchObject({
      type: 'team.done',
      status: 'budget_exceeded',
    });
  });

  it('6. supports both whole-team cancellation and single-agent cancellation', async () => {
    // Part A: Whole-team cancellation
    {
      const clock = new FakeClock();
      const store = new MemoryStore();
      const taskStarted = createDeferred<void>();
      let agentSignalAborted = false;

      const runner = makeFakeRunner(async function* (req) {
        if (req.role === 'planner') {
          yield {
            type: 'result',
            output: JSON.stringify({
              tasks: [
                {
                  id: 't1',
                  title: 'Long task',
                  description: 'Runs until cancelled',
                  dependsOn: [],
                  suggestedRole: 'worker',
                  acceptanceCriteria: ['Done'],
                },
              ],
            }),
          };
          yield { type: 'done', tokens: 20, costUsd: 0.01 };
          return;
        }

        taskStarted.resolve();
        await new Promise<void>((resolve) => {
          req.signal.addEventListener(
            'abort',
            () => {
              agentSignalAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      });

      const orchestrator = new TeamOrchestrator({ runner, clock, store });
      const runPromise = orchestrator.run({
        runId: 'run-cancel-team',
        goal: 'Cancellable goal',
        baseWorkdir: '/work',
        budget: { maxTokens: 5000, maxCostUsd: 2 },
      });

      await taskStarted.promise;
      await orchestrator.cancelTeam('run-cancel-team', 'User requested stop');

      const finalState = await runPromise;
      expect(agentSignalAborted).toBe(true);
      expect(finalState.status).toBe('cancelled');
      expect(finalState.tasks[0]?.status).toBe('cancelled');
      expect(finalState.events.at(-1)).toMatchObject({
        type: 'team.done',
        status: 'cancelled',
        reason: 'User requested stop',
      });
    }

    // Part B: Single-agent cancellation while sibling task continues
    {
      const clock = new FakeClock();
      const store = new MemoryStore();
      const t1Started = createDeferred<void>();
      const t2Gate = createDeferred<void>();

      const runner = makeFakeRunner(async function* (req) {
        if (req.role === 'planner') {
          yield {
            type: 'result',
            output: JSON.stringify({
              tasks: [
                {
                  id: 't1',
                  title: 'Optional branch',
                  description: 'Cancel this one',
                  dependsOn: [],
                  suggestedRole: 'worker',
                  acceptanceCriteria: ['Done'],
                },
                {
                  id: 't2',
                  title: 'Essential branch',
                  description: 'Keep this one',
                  dependsOn: [],
                  suggestedRole: 'worker',
                  acceptanceCriteria: ['Done'],
                },
              ],
            }),
          };
          yield { type: 'done', tokens: 20, costUsd: 0.01 };
          return;
        }

        if (req.role === 'reviewer') {
          yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
          yield { type: 'done', tokens: 10, costUsd: 0.002 };
          return;
        }

        if (req.taskId === 't1') {
          t1Started.resolve();
          await new Promise<void>((resolve) => {
            req.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }

        await t2Gate.promise;
        yield { type: 'result', output: 't2 succeeded' };
        yield { type: 'done', tokens: 40, costUsd: 0.01 };
      });

      const orchestrator = new TeamOrchestrator({ runner, clock, store }, { maxConcurrency: 2 });
      const runPromise = orchestrator.run({
        runId: 'run-cancel-agent',
        goal: 'Partial cancel',
        baseWorkdir: '/work',
        budget: { maxTokens: 5000, maxCostUsd: 2 },
      });

      await t1Started.promise;
      await orchestrator.cancelAgent('run-cancel-agent', 't1', 'Branch no longer needed');
      t2Gate.resolve();

      const finalState = await runPromise;
      expect(finalState.status).toBe('completed');
      expect(finalState.tasks.find((t) => t.id === 't1')?.status).toBe('cancelled');
      expect(finalState.tasks.find((t) => t.id === 't2')?.status).toBe('completed');
    }
  });

  it('7. recovers mid-flight after simulated crash using persisted Store state', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const t2MidFlight = createDeferred<void>();
    let crashTriggered = false;

    const crashingRunner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 't1',
                title: 'Step 1',
                description: 'Completes before crash',
                dependsOn: [],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
              {
                id: 't2',
                title: 'Step 2',
                description: 'In-flight during crash',
                dependsOn: ['t1'],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
              {
                id: 't3',
                title: 'Step 3',
                description: 'Runs after recovery',
                dependsOn: ['t2'],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 50, costUsd: 0.01 };
        return;
      }

      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 20, costUsd: 0.005 };
        return;
      }

      if (req.taskId === 't1') {
        yield { type: 'result', output: 't1 finished', changedFiles: ['src/step1.ts'] };
        yield { type: 'done', tokens: 40, costUsd: 0.01 };
        return;
      }

      if (req.taskId === 't2' && !crashTriggered) {
        crashTriggered = true;
        t2MidFlight.resolve();
        // Hang forever to simulate abrupt process termination mid-flight
        await new Promise<void>(() => {});
      }

      yield { type: 'result', output: `${req.taskId} recovered output` };
      yield { type: 'done', tokens: 40, costUsd: 0.01 };
    });

    const firstOrchestrator = new TeamOrchestrator({
      runner: crashingRunner,
      clock,
      store,
    });

    // Fire first run without awaiting (it hangs mid-flight on t2)
    void firstOrchestrator.run({
      runId: 'run-crash-recover',
      goal: 'Survive crash',
      baseWorkdir: '/work',
      budget: { maxTokens: 5000, maxCostUsd: 2 },
    });

    await t2MidFlight.promise;
    // Allow store save to flush
    await new Promise((r) => setTimeout(r, 10));

    const crashedSnapshot = await store.load('run-crash-recover');
    expect(crashedSnapshot).not.toBeNull();
    expect(crashedSnapshot?.status).toBe('running');
    expect(crashedSnapshot?.tasks.find((t) => t.id === 't1')?.status).toBe('completed');
    expect(crashedSnapshot?.tasks.find((t) => t.id === 't2')?.status).toBe('running');
    expect(crashedSnapshot?.tasks.find((t) => t.id === 't3')?.status).toBe('pending');

    // Spin up a brand-new orchestrator instance against the same Store and resume
    const executedAfterRestart: string[] = [];
    const recoveryRunner = makeFakeRunner(async function* (req) {
      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 20, costUsd: 0.005 };
        return;
      }
      executedAfterRestart.push(`${req.role}:${req.taskId}`);
      yield { type: 'result', output: `${req.taskId} done after restart` };
      yield { type: 'done', tokens: 40, costUsd: 0.01 };
    });

    const recoveredOrchestrator = new TeamOrchestrator({
      runner: recoveryRunner,
      clock,
      store,
    });

    const recoveredFinal = await recoveredOrchestrator.resume('run-crash-recover');

    expect(recoveredFinal.status).toBe('completed');
    // t1 was already completed before crash and must NOT be re-run
    expect(executedAfterRestart).toEqual(['worker:t2', 'worker:t3']);
    // Event sequence numbers remained strictly contiguous across restart
    expect(recoveredFinal.events.map((e) => e.seq)).toEqual(
      recoveredFinal.events.map((_, idx) => idx + 1),
    );
  });

  it('8. recovers from invalid planner JSON and cyclic DAG responses by re-prompting up to 2 times', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const plannerPrompts: string[] = [];
    let plannerAttempt = 0;

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        plannerAttempt += 1;
        plannerPrompts.push(req.prompt);

        if (plannerAttempt === 1) {
          // Attempt 1: malformed JSON
          yield { type: 'result', output: '{ "tasks": [ broken json ' };
          yield { type: 'done', tokens: 30, costUsd: 0.005 };
          return;
        }

        if (plannerAttempt === 2) {
          // Attempt 2: valid JSON, but contains a dependency cycle a -> b -> a
          yield {
            type: 'result',
            output: JSON.stringify({
              tasks: [
                {
                  id: 'a',
                  title: 'Task A',
                  description: 'Depends on B',
                  dependsOn: ['b'],
                  suggestedRole: 'worker',
                  acceptanceCriteria: ['Done'],
                },
                {
                  id: 'b',
                  title: 'Task B',
                  description: 'Depends on A',
                  dependsOn: ['a'],
                  suggestedRole: 'worker',
                  acceptanceCriteria: ['Done'],
                },
              ],
            }),
          };
          yield { type: 'done', tokens: 35, costUsd: 0.005 };
          return;
        }

        // Attempt 3: valid DAG
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 'a',
                title: 'Task A',
                description: 'Root task',
                dependsOn: [],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
              {
                id: 'b',
                title: 'Task B',
                description: 'Depends on A',
                dependsOn: ['a'],
                suggestedRole: 'worker',
                acceptanceCriteria: ['Done'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 45, costUsd: 0.005 };
        return;
      }

      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 15, costUsd: 0.002 };
        return;
      }

      yield { type: 'result', output: `Finished ${req.taskId}` };
      yield { type: 'done', tokens: 30, costUsd: 0.005 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store });

    const finalState = await orchestrator.run({
      runId: 'run-planner-recovery',
      goal: 'Recover from bad planner outputs',
      baseWorkdir: '/work',
      budget: { maxTokens: 5000, maxCostUsd: 2 },
    });

    expect(finalState.status).toBe('completed');
    expect(plannerAttempt).toBe(3);
    expect(finalState.planAttempts).toBe(3);
    expect(plannerPrompts[1]).toContain('Invalid JSON syntax');
    expect(plannerPrompts[2]).toContain('Dependency cycle detected: a -> b -> a');
  });

  it('9. supports human take-over: pause running agent, hand off to human, and resume', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const taskRunning = createDeferred<void>();

    const runner = makeFakeRunner(async function* (req) {
      if (req.role === 'planner') {
        yield {
          type: 'result',
          output: JSON.stringify({
            tasks: [
              {
                id: 't1',
                title: 'Configure production secrets',
                description: 'Needs human vault key',
                dependsOn: [],
                suggestedRole: 'ops',
                acceptanceCriteria: ['Secrets configured'],
              },
              {
                id: 't2',
                title: 'Deploy service',
                description: 'Deploy after secrets ready',
                dependsOn: ['t1'],
                suggestedRole: 'ops',
                acceptanceCriteria: ['Service healthy'],
              },
            ],
          }),
        };
        yield { type: 'done', tokens: 30, costUsd: 0.01 };
        return;
      }

      if (req.role === 'reviewer') {
        yield { type: 'result', output: JSON.stringify({ verdict: 'accept' }) };
        yield { type: 'done', tokens: 15, costUsd: 0.002 };
        return;
      }

      if (req.taskId === 't1') {
        taskRunning.resolve();
        await new Promise<void>((resolve) => {
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }

      yield { type: 'result', output: 'Deployed successfully' };
      yield { type: 'done', tokens: 40, costUsd: 0.01 };
    });

    const orchestrator = new TeamOrchestrator({ runner, clock, store });
    const runPromise = orchestrator.run({
      runId: 'run-takeover',
      goal: 'Deploy with human secret handoff',
      baseWorkdir: '/work',
      budget: { maxTokens: 5000, maxCostUsd: 2 },
    });

    await taskRunning.promise;
    await orchestrator.pauseForTakeover('run-takeover', 't1', 'Human entering vault credentials');

    const pausedState = await orchestrator.getState('run-takeover');
    expect(pausedState?.tasks.find((t) => t.id === 't1')?.status).toBe('paused_human');

    await orchestrator.resumeFromTakeover('run-takeover', 't1', {
      result: 'Human configured vault secrets in .env.prod',
      changedFiles: ['.env.prod'],
    });

    const finalState = await runPromise;
    expect(finalState.status).toBe('completed');
    expect(finalState.tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
  });
});
