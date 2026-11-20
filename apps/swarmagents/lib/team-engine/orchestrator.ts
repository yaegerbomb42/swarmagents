import path from 'node:path';
import {
  buildPlannerPrompt,
  buildReplanPrompt,
  buildReviewerPrompt,
  buildWorkerPrompt,
} from './prompts';
import {
  HARD_MAX_TASKS,
  normalizeFilePath,
  parseReviewVerdict,
  PlanValidationError,
  ReviewValidationError,
  validatePlanDag,
  type ValidatedPlanTask,
} from './schemas';
import type {
  AgentRunRequest,
  FileConflict,
  HumanTakeoverInput,
  MergeSummary,
  NewTeamEvent,
  OrchestratorConfig,
  OrchestratorDependencies,
  ResumeTeamOptions,
  RunTeamOptions,
  TaskRecord,
  TeamEvent,
  TeamEventListener,
  TeamRunState,
  TeamStatus,
} from './types';

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

interface ActiveRunContext {
  state: TeamRunState;
  maxConcurrency: number;
  returnWhenPaused: boolean;
  taskControllers: Map<string, AbortController>;
  plannerController: AbortController | null;
  inFlight: Map<string, Promise<void>>;
  wakeResolvers: Set<() => void>;
  pausedTaskIds: Set<string>;
  cancelledTaskIds: Set<string>;
  teamCancelled: boolean;
  teamCancelReason?: string;
  budgetExceeded: boolean;
  persistChain: Promise<void>;
}

interface StreamConsumptionResult {
  output: string | null;
  changedFiles: string[];
  error: string | null;
  aborted: boolean;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrency: 4,
  maxTasks: HARD_MAX_TASKS,
  maxPlanRetries: 2,
  maxTaskRetries: 2,
  maxReplans: 2,
  plannerRole: 'planner',
  reviewerRole: 'reviewer',
  resolveWorkdir: (baseWorkdir: string, taskId: string) =>
    path.posix.join(baseWorkdir, 'tasks', taskId),
};

export class TeamOrchestrator {
  private readonly deps: OrchestratorDependencies;
  private readonly config: OrchestratorConfig;
  private readonly activeRuns = new Map<string, ActiveRunContext>();
  private readonly listeners = new Map<string, Set<TeamEventListener>>();

  constructor(deps: OrchestratorDependencies, config: Partial<OrchestratorConfig> = {}) {
    this.deps = deps;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      maxTasks: Math.min(config.maxTasks ?? DEFAULT_CONFIG.maxTasks, HARD_MAX_TASKS),
    };
  }

  subscribe(runId: string, listener: TeamEventListener): () => void {
    let runListeners = this.listeners.get(runId);
    if (!runListeners) {
      runListeners = new Set();
      this.listeners.set(runId, runListeners);
    }
    runListeners.add(listener);
    return () => {
      runListeners?.delete(listener);
      if (runListeners && runListeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  async getState(runId: string): Promise<TeamRunState | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      return structuredClone(active.state);
    }
    return this.deps.store.load(runId);
  }

  async run(options: RunTeamOptions): Promise<TeamRunState> {
    if (this.activeRuns.has(options.runId)) {
      throw new OrchestratorError(`Run "${options.runId}" is already active`);
    }
    const existing = await this.deps.store.load(options.runId);
    if (existing) {
      throw new OrchestratorError(
        `Run "${options.runId}" already exists in store; use resume() instead`,
      );
    }

    const now = this.deps.clock.now();
    const initialState: TeamRunState = {
      runId: options.runId,
      goal: options.goal,
      baseWorkdir: options.baseWorkdir,
      status: 'planning',
      budget: {
        maxTokens: options.budget.maxTokens,
        maxCostUsd: options.budget.maxCostUsd,
      },
      usage: {
        totalTokens: 0,
        totalCostUsd: 0,
      },
      planAttempts: 0,
      replansUsed: 0,
      tasks: [],
      events: [],
      lastEventSeq: 0,
      createdAt: now,
      updatedAt: now,
    };

    const ctx = this.createContext(initialState, {
      maxConcurrency: options.maxConcurrency ?? this.config.maxConcurrency,
      returnWhenPaused: options.returnWhenPaused ?? false,
    });

    this.activeRuns.set(options.runId, ctx);
    await this.persist(ctx);

    try {
      return await this.driveRun(ctx);
    } finally {
      this.activeRuns.delete(options.runId);
    }
  }

  async resume(runId: string, options: ResumeTeamOptions = {}): Promise<TeamRunState> {
    if (this.activeRuns.has(runId)) {
      throw new OrchestratorError(`Run "${runId}" is already active`);
    }

    const loaded = await this.deps.store.load(runId);
    if (!loaded) {
      throw new OrchestratorError(`Run "${runId}" not found in store`);
    }

    if (
      loaded.status === 'completed' ||
      loaded.status === 'failed' ||
      loaded.status === 'cancelled'
    ) {
      return loaded;
    }

    if (options.budgetOverride) {
      loaded.budget = {
        maxTokens: options.budgetOverride.maxTokens,
        maxCostUsd: options.budgetOverride.maxCostUsd,
      };
    }

    if (loaded.status === 'budget_exceeded') {
      if (
        loaded.usage.totalTokens >= loaded.budget.maxTokens ||
        loaded.usage.totalCostUsd >= loaded.budget.maxCostUsd
      ) {
        return loaded;
      }
      loaded.status = loaded.tasks.length > 0 ? 'running' : 'planning';
      loaded.terminalReason = undefined;
    }

    // Recover any tasks that were mid-flight when the process crashed
    for (const task of loaded.tasks) {
      if (task.status === 'running') {
        task.status = 'pending';
        task.attempts = Math.max(0, task.attempts - 1);
      } else if (task.status === 'reviewing') {
        if (task.lastResult === undefined) {
          task.status = 'pending';
          task.attempts = Math.max(0, task.attempts - 1);
        }
      }
    }

    const ctx = this.createContext(loaded, {
      maxConcurrency: options.maxConcurrency ?? this.config.maxConcurrency,
      returnWhenPaused: options.returnWhenPaused ?? false,
    });

    this.activeRuns.set(runId, ctx);
    await this.persist(ctx);

    try {
      return await this.driveRun(ctx);
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async cancelTeam(runId: string, reason = 'Team cancelled'): Promise<void> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      const stored = await this.deps.store.load(runId);
      if (!stored) {
        throw new OrchestratorError(`Run "${runId}" not found`);
      }
      if (this.isTerminalStatus(stored.status)) {
        return;
      }
      for (const task of stored.tasks) {
        if (!this.isTerminalTaskStatus(task.status)) {
          task.status = 'cancelled';
        }
      }
      stored.status = 'cancelled';
      stored.terminalReason = reason;
      stored.updatedAt = this.deps.clock.now();
      const doneEvent = this.buildDoneEvent(stored, 'cancelled', reason);
      stored.lastEventSeq += 1;
      stored.events.push({
        seq: stored.lastEventSeq,
        timestamp: stored.updatedAt,
        runId,
        ...doneEvent,
      });
      await this.deps.store.save(stored);
      return;
    }

    ctx.teamCancelled = true;
    ctx.teamCancelReason = reason;
    ctx.plannerController?.abort();
    for (const controller of ctx.taskControllers.values()) {
      controller.abort();
    }
    this.wake(ctx);
  }

  async cancelAgent(runId: string, taskId: string, reason = 'Agent cancelled'): Promise<void> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      throw new OrchestratorError(`Run "${runId}" is not active`);
    }

    const task = ctx.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new OrchestratorError(`Task "${taskId}" not found in run "${runId}"`);
    }

    if (this.isTerminalTaskStatus(task.status)) {
      return;
    }

    ctx.cancelledTaskIds.add(taskId);
    ctx.pausedTaskIds.delete(taskId);
    const controller = ctx.taskControllers.get(taskId);
    if (controller) {
      controller.abort();
    }

    task.status = 'cancelled';
    task.lastError = reason;

    // Cancel transitive dependents of the cancelled task
    const dependents = this.findTransitiveDependents(ctx.state.tasks, taskId);
    for (const dep of dependents) {
      if (!this.isTerminalTaskStatus(dep.status)) {
        ctx.cancelledTaskIds.add(dep.id);
        ctx.taskControllers.get(dep.id)?.abort();
        dep.status = 'cancelled';
        dep.lastError = `Upstream task "${taskId}" was cancelled`;
      }
    }

    await this.emitEvent(ctx, {
      type: 'task.cancelled',
      taskId,
      reason,
    });
    this.wake(ctx);
  }

  async pauseForTakeover(runId: string, taskId: string, reason?: string): Promise<void> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      throw new OrchestratorError(`Run "${runId}" is not active`);
    }

    const task = ctx.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new OrchestratorError(`Task "${taskId}" not found in run "${runId}"`);
    }

    if (
      task.status !== 'running' &&
      task.status !== 'reviewing' &&
      task.status !== 'pending'
    ) {
      throw new OrchestratorError(
        `Cannot pause task "${taskId}" from status "${task.status}"`,
      );
    }

    const wasRunning = task.status === 'running';
    ctx.pausedTaskIds.add(taskId);
    const controller = ctx.taskControllers.get(taskId);
    if (controller) {
      controller.abort();
    }

    if (wasRunning) {
      task.attempts = Math.max(0, task.attempts - 1);
    }
    task.status = 'paused_human';
    task.pauseReason = reason;

    await this.emitEvent(ctx, {
      type: 'task.paused',
      taskId,
      reason,
    });
    this.wake(ctx);
  }

  async resumeFromTakeover(
    runId: string,
    taskId: string,
    input: HumanTakeoverInput,
  ): Promise<void> {
    const ctx = this.activeRuns.get(runId);
    const state = ctx ? ctx.state : await this.deps.store.load(runId);
    if (!state) {
      throw new OrchestratorError(`Run "${runId}" not found`);
    }

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new OrchestratorError(`Task "${taskId}" not found in run "${runId}"`);
    }

    if (task.status !== 'paused_human') {
      throw new OrchestratorError(
        `Task "${taskId}" is not paused for human takeover (current status: "${task.status}")`,
      );
    }

    ctx?.pausedTaskIds.delete(taskId);
    task.pauseReason = undefined;

    if (input.changedFiles && input.changedFiles.length > 0) {
      this.mergeTaskChangedFiles(task, input.changedFiles);
    }

    if (input.result !== undefined) {
      task.lastResult = input.result;
      task.attempts = Math.max(1, task.attempts);

      if (ctx) {
        await this.emitEvent(ctx, {
          type: 'task.resumed',
          taskId,
          mode: 'human_result',
        });
      }

      if (input.skipReview) {
        const conflicts = this.detectTaskConflicts(state.tasks, task);
        task.conflicts = conflicts;
        task.conflictReviewed = true;
        task.status = 'completed';

        if (ctx) {
          await this.emitEvent(ctx, {
            type: 'task.review',
            taskId,
            attempt: task.attempts,
            verdict: 'accept',
            feedback: 'Accepted via human takeover',
            conflicts,
          });
        }
      } else {
        task.status = 'reviewing';
        if (ctx) {
          await this.persist(ctx);
        }
      }
    } else {
      if (input.instructions) {
        task.humanInstructions.push(input.instructions);
      }
      task.status = 'pending';

      if (ctx) {
        await this.emitEvent(ctx, {
          type: 'task.resumed',
          taskId,
          mode: 'agent_with_instructions',
        });
      }
    }

    if (ctx) {
      this.wake(ctx);
    } else {
      state.updatedAt = this.deps.clock.now();
      await this.deps.store.save(state);
      void this.resume(runId);
    }
  }

  private createContext(
    state: TeamRunState,
    opts: { maxConcurrency: number; returnWhenPaused: boolean },
  ): ActiveRunContext {
    return {
      state,
      maxConcurrency: Math.max(1, opts.maxConcurrency),
      returnWhenPaused: opts.returnWhenPaused,
      taskControllers: new Map(),
      plannerController: null,
      inFlight: new Map(),
      wakeResolvers: new Set(),
      pausedTaskIds: new Set(
        state.tasks.filter((t) => t.status === 'paused_human').map((t) => t.id),
      ),
      cancelledTaskIds: new Set(
        state.tasks.filter((t) => t.status === 'cancelled').map((t) => t.id),
      ),
      teamCancelled: false,
      budgetExceeded: false,
      persistChain: Promise.resolve(),
    };
  }

  private async driveRun(ctx: ActiveRunContext): Promise<TeamRunState> {
    if (ctx.state.status === 'planning') {
      const planned = await this.executeInitialPlanning(ctx);
      if (!planned) {
        return structuredClone(ctx.state);
      }
    }

    // Main scheduling loop
    while (!this.isTerminalStatus(ctx.state.status)) {
      if (ctx.teamCancelled) {
        await this.finalizeCancelled(ctx);
        break;
      }

      if (ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
        await this.finalizeBudgetExceeded(ctx);
        break;
      }

      // 1. Dispatch review passes for any tasks currently in 'reviewing' (e.g., recovered or human-submitted)
      for (const task of ctx.state.tasks) {
        if (
          task.status === 'reviewing' &&
          !ctx.inFlight.has(task.id) &&
          !ctx.teamCancelled &&
          !ctx.budgetExceeded
        ) {
          const promise = this.runReviewOnlyLifecycle(ctx, task).finally(() => {
            ctx.inFlight.delete(task.id);
            this.wake(ctx);
          });
          ctx.inFlight.set(task.id, promise);
        }
      }

      // 2. Dispatch ready 'pending' tasks up to maxConcurrency
      if (!ctx.teamCancelled && !ctx.budgetExceeded && !this.isBudgetReached(ctx.state)) {
        const availableSlots = Math.max(0, ctx.maxConcurrency - ctx.inFlight.size);
        if (availableSlots > 0) {
          const readyTasks = this.getReadyTasks(ctx.state.tasks).slice(0, availableSlots);
          for (const task of readyTasks) {
            if (ctx.teamCancelled || ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
              break;
            }
            const promise = this.executeTaskLifecycle(ctx, task).finally(() => {
              ctx.inFlight.delete(task.id);
              this.wake(ctx);
            });
            ctx.inFlight.set(task.id, promise);
          }
        }
      }

      if (ctx.teamCancelled) {
        await this.finalizeCancelled(ctx);
        break;
      }

      if (ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
        await this.finalizeBudgetExceeded(ctx);
        break;
      }

      // 3. Check if all tasks have reached terminal states
      if (
        ctx.inFlight.size === 0 &&
        ctx.state.tasks.every((t) => this.isTerminalTaskStatus(t.status))
      ) {
        await this.executeMergeAndFinalize(ctx);
        break;
      }

      // 4. Handle human-paused state when nothing else can run right now
      const hasPaused = ctx.state.tasks.some((t) => t.status === 'paused_human');
      if (ctx.inFlight.size === 0 && hasPaused) {
        if (ctx.returnWhenPaused) {
          await this.persist(ctx);
          return structuredClone(ctx.state);
        }
        await this.waitForWake(ctx);
        continue;
      }

      // 5. Deadlock safety guard (e.g., pending tasks whose dependencies were cancelled)
      if (ctx.inFlight.size === 0) {
        const hasPending = ctx.state.tasks.some((t) => t.status === 'pending');
        if (hasPending) {
          for (const task of ctx.state.tasks) {
            if (task.status === 'pending') {
              task.status = 'failed';
              task.lastError = 'Task became unschedulable due to upstream terminal states';
              await this.emitEvent(ctx, {
                type: 'task.failed',
                taskId: task.id,
                attempts: task.attempts,
                reason: task.lastError,
              });
            }
          }
          continue;
        }
      }

      // Wait for any in-flight task to settle or an external control event (pause/resume/cancel)
      await this.waitForProgress(ctx);
    }

    await ctx.persistChain;
    return structuredClone(ctx.state);
  }

  private async executeInitialPlanning(ctx: ActiveRunContext): Promise<boolean> {
    const maxAttempts = 1 + this.config.maxPlanRetries;
    let validationError: string | undefined;
    let previousRawOutput: string | undefined;

    while (ctx.state.planAttempts < maxAttempts) {
      if (ctx.teamCancelled) {
        await this.finalizeCancelled(ctx);
        return false;
      }

      if (ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
        await this.finalizeBudgetExceeded(ctx);
        return false;
      }

      ctx.state.planAttempts += 1;
      const attempt = ctx.state.planAttempts;

      const prompt = buildPlannerPrompt({
        goal: ctx.state.goal,
        baseWorkdir: ctx.state.baseWorkdir,
        maxTasks: this.config.maxTasks,
        validationError,
        previousRawOutput,
      });

      const controller = new AbortController();
      ctx.plannerController = controller;

      const streamResult = await this.consumeAgentStream(ctx, {
        runId: ctx.state.runId,
        attempt,
        role: this.config.plannerRole,
        prompt,
        workdir: ctx.state.baseWorkdir,
        budget: this.getRemainingBudget(ctx.state),
        signal: controller.signal,
      });

      ctx.plannerController = null;

      if (ctx.teamCancelled) {
        await this.finalizeCancelled(ctx);
        return false;
      }

      if (ctx.budgetExceeded) {
        await this.finalizeBudgetExceeded(ctx);
        return false;
      }

      if (streamResult.output === null) {
        validationError = streamResult.error ?? 'Planner produced no result output';
        previousRawOutput = undefined;
        continue;
      }

      try {
        const validatedTasks = validatePlanDag(streamResult.output, {
          maxTasks: this.config.maxTasks,
        });

        ctx.state.tasks = validatedTasks.map((t) => this.toTaskRecord(ctx.state.baseWorkdir, t));
        ctx.state.status = 'running';

        await this.emitEvent(ctx, {
          type: 'team.plan',
          isReplan: false,
          tasks: validatedTasks.map((t) => ({
            id: t.id,
            title: t.title,
            dependsOn: [...t.dependsOn],
            suggestedRole: t.suggestedRole,
          })),
        });

        return true;
      } catch (err) {
        if (err instanceof PlanValidationError) {
          validationError = err.message;
          previousRawOutput = streamResult.output;
        } else {
          throw err;
        }
      }
    }

    const reason = `Planner failed to produce a valid DAG after ${maxAttempts} attempts: ${validationError ?? 'unknown error'}`;
    await this.finalizeTerminal(ctx, 'failed', reason);
    return false;
  }

  private async executeTaskLifecycle(ctx: ActiveRunContext, task: TaskRecord): Promise<void> {
    if (ctx.teamCancelled || ctx.cancelledTaskIds.has(task.id) || ctx.pausedTaskIds.has(task.id)) {
      return;
    }

    task.attempts += 1;
    const attempt = task.attempts;
    task.status = 'running';

    await this.emitEvent(ctx, {
      type: 'task.started',
      taskId: task.id,
      title: task.title,
      role: task.suggestedRole,
      attempt,
      workdir: task.workdir,
    });

    const dependencyOutputs = task.dependsOn
      .map((depId) => ctx.state.tasks.find((t) => t.id === depId))
      .filter((t): t is TaskRecord => t !== undefined && t.status === 'completed')
      .map((t) => ({
        id: t.id,
        title: t.title,
        output: t.lastResult ?? '',
        changedFiles: [...t.changedFiles],
      }));

    const workerPrompt = buildWorkerPrompt({
      goal: ctx.state.goal,
      task,
      attempt,
      dependencyOutputs,
    });

    const controller = new AbortController();
    ctx.taskControllers.set(task.id, controller);

    const workerResult = await this.consumeAgentStream(ctx, {
      runId: ctx.state.runId,
      taskId: task.id,
      attempt,
      role: task.suggestedRole,
      prompt: workerPrompt,
      workdir: task.workdir,
      budget: this.getRemainingBudget(ctx.state),
      signal: controller.signal,
    });

    ctx.taskControllers.delete(task.id);

    // Check external interruptions first. pauseTask/cancelTask may have
    // mutated task.status while we awaited, so re-read it un-narrowed.
    const statusNow = task.status as TaskRecord['status'];
    if (ctx.teamCancelled) {
      return;
    }
    if (ctx.pausedTaskIds.has(task.id) || statusNow === 'paused_human') {
      return;
    }
    if (ctx.cancelledTaskIds.has(task.id) || statusNow === 'cancelled') {
      return;
    }
    if (ctx.budgetExceeded) {
      task.status = 'pending';
      task.attempts = Math.max(0, task.attempts - 1);
      return;
    }

    if (workerResult.changedFiles.length > 0) {
      this.mergeTaskChangedFiles(task, workerResult.changedFiles);
    }

    if (workerResult.output === null) {
      const errorMsg = workerResult.error ?? 'Worker agent finished without producing a result';
      task.lastError = errorMsg;
      await this.handleTaskAttemptRejection(ctx, task, errorMsg);
      return;
    }

    task.lastResult = workerResult.output;
    task.lastError = undefined;
    task.status = 'reviewing';
    await this.persist(ctx);

    await this.runReviewOnlyLifecycle(ctx, task);
  }

  private async runReviewOnlyLifecycle(
    ctx: ActiveRunContext,
    task: TaskRecord,
    isMergeConflictPass = false,
  ): Promise<void> {
    if (ctx.teamCancelled || ctx.cancelledTaskIds.has(task.id) || ctx.pausedTaskIds.has(task.id)) {
      return;
    }

    const conflicts = this.detectTaskConflicts(ctx.state.tasks, task);
    task.conflicts = conflicts;

    const maxReviewAttempts = 1 + this.config.maxPlanRetries;
    let reviewParseError: string | undefined;

    for (let rAttempt = 1; rAttempt <= maxReviewAttempts; rAttempt++) {
      if (ctx.teamCancelled || ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
        if (this.isBudgetReached(ctx.state)) {
          ctx.budgetExceeded = true;
        }
        return;
      }

      let reviewPrompt = buildReviewerPrompt({
        goal: ctx.state.goal,
        task,
        attempt: task.attempts,
        workerOutput: task.lastResult ?? '',
        changedFiles: task.changedFiles,
        conflicts,
        isMergeConflictPass,
      });

      if (reviewParseError) {
        reviewPrompt += `\n\nPREVIOUS REVIEW JSON WAS INVALID (${reviewParseError}). Return ONLY valid JSON.`;
      }

      const controller = new AbortController();
      ctx.taskControllers.set(task.id, controller);

      const reviewStream = await this.consumeAgentStream(ctx, {
        runId: ctx.state.runId,
        taskId: task.id,
        attempt: task.attempts,
        role: this.config.reviewerRole,
        prompt: reviewPrompt,
        workdir: ctx.state.baseWorkdir,
        budget: this.getRemainingBudget(ctx.state),
        signal: controller.signal,
      });

      ctx.taskControllers.delete(task.id);

      if (ctx.teamCancelled) {
        return;
      }
      if (ctx.pausedTaskIds.has(task.id) || task.status === 'paused_human') {
        return;
      }
      if (ctx.cancelledTaskIds.has(task.id) || task.status === 'cancelled') {
        return;
      }
      if (ctx.budgetExceeded) {
        return;
      }

      if (reviewStream.output === null) {
        reviewParseError = reviewStream.error ?? 'Reviewer produced no result output';
        continue;
      }

      try {
        const verdict = parseReviewVerdict(reviewStream.output);
        task.conflictReviewed = true;

        await this.emitEvent(ctx, {
          type: 'task.review',
          taskId: task.id,
          attempt: task.attempts,
          verdict: verdict.verdict,
          feedback: verdict.feedback,
          conflicts,
        });

        if (verdict.verdict === 'accept') {
          task.status = 'completed';
          task.lastFeedback = undefined;
          await this.persist(ctx);
          return;
        }

        const feedback = verdict.feedback ?? 'Rejected by reviewer';
        await this.handleTaskAttemptRejection(ctx, task, feedback);
        return;
      } catch (err) {
        if (err instanceof ReviewValidationError) {
          reviewParseError = err.message;
        } else {
          throw err;
        }
      }
    }

    const fallbackReason = `Reviewer returned invalid JSON after ${maxReviewAttempts} attempts: ${reviewParseError ?? 'unknown'}`;
    await this.handleTaskAttemptRejection(ctx, task, fallbackReason);
  }

  private async handleTaskAttemptRejection(
    ctx: ActiveRunContext,
    task: TaskRecord,
    reason: string,
  ): Promise<void> {
    task.lastFeedback = reason;

    if (task.retriesUsed < this.config.maxTaskRetries) {
      task.retriesUsed += 1;
      task.status = 'pending';

      await this.emitEvent(ctx, {
        type: 'task.retry',
        taskId: task.id,
        nextAttempt: task.attempts + 1,
        reason,
      });
      return;
    }

    // Retries exhausted -> mark task failed and replan dependents
    task.status = 'failed';
    await this.emitEvent(ctx, {
      type: 'task.failed',
      taskId: task.id,
      attempts: task.attempts,
      reason,
    });

    await this.replanDependentsForFailedTask(ctx, task);
  }

  private async replanDependentsForFailedTask(
    ctx: ActiveRunContext,
    failedTask: TaskRecord,
  ): Promise<void> {
    const dependents = this.findTransitiveDependents(ctx.state.tasks, failedTask.id).filter(
      (t) =>
        t.status !== 'completed' &&
        t.status !== 'failed' &&
        t.status !== 'cancelled' &&
        t.status !== 'superseded',
    );

    if (dependents.length === 0) {
      return;
    }

    // Abort any running dependent tasks and mark them superseded
    for (const dep of dependents) {
      ctx.taskControllers.get(dep.id)?.abort();
      dep.status = 'superseded';
      dep.lastError = `Superseded due to upstream failure of "${failedTask.id}"`;
    }
    await this.persist(ctx);

    if (ctx.state.replansUsed >= this.config.maxReplans) {
      return;
    }

    if (ctx.teamCancelled || ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
      if (this.isBudgetReached(ctx.state)) {
        ctx.budgetExceeded = true;
      }
      return;
    }

    ctx.state.replansUsed += 1;

    const completedTasks = ctx.state.tasks.filter((t) => t.status === 'completed');
    const remainingActiveTasks = ctx.state.tasks.filter(
      (t) =>
        t.status === 'pending' ||
        t.status === 'running' ||
        t.status === 'reviewing' ||
        t.status === 'paused_human',
    );
    const forbiddenTaskIds = new Set(
      ctx.state.tasks
        .filter((t) => t.status === 'failed' || t.status === 'superseded' || t.status === 'cancelled')
        .map((t) => t.id),
    );
    const existingValidTaskIds = new Set([
      ...completedTasks.map((t) => t.id),
      ...remainingActiveTasks.map((t) => t.id),
    ]);
    const existingAllTaskIds = new Set(ctx.state.tasks.map((t) => t.id));
    const existingActiveCount = completedTasks.length + remainingActiveTasks.length;
    const maxNewTasks = Math.max(1, this.config.maxTasks - existingActiveCount);

    const maxPlanAttempts = 1 + this.config.maxPlanRetries;
    let validationError: string | undefined;
    let previousRawOutput: string | undefined;

    for (let attempt = 1; attempt <= maxPlanAttempts; attempt++) {
      if (ctx.teamCancelled || ctx.budgetExceeded || this.isBudgetReached(ctx.state)) {
        if (this.isBudgetReached(ctx.state)) {
          ctx.budgetExceeded = true;
        }
        return;
      }

      const prompt = buildReplanPrompt({
        goal: ctx.state.goal,
        baseWorkdir: ctx.state.baseWorkdir,
        maxNewTasks,
        failedTask,
        completedTasks,
        supersededTasks: dependents,
        remainingActiveTasks,
        validationError,
        previousRawOutput,
      });

      const controller = new AbortController();
      ctx.plannerController = controller;

      const streamResult = await this.consumeAgentStream(ctx, {
        runId: ctx.state.runId,
        attempt,
        role: this.config.plannerRole,
        prompt,
        workdir: ctx.state.baseWorkdir,
        budget: this.getRemainingBudget(ctx.state),
        signal: controller.signal,
      });

      ctx.plannerController = null;

      if (ctx.teamCancelled || ctx.budgetExceeded) {
        return;
      }

      if (streamResult.output === null) {
        validationError = streamResult.error ?? 'Replanner produced no result output';
        previousRawOutput = undefined;
        continue;
      }

      try {
        const validatedReplacements = validatePlanDag(streamResult.output, {
          maxTasks: maxNewTasks,
          existingValidTaskIds,
          existingAllTaskIds,
          forbiddenTaskIds,
          existingActiveCount,
        });

        const newRecords = validatedReplacements.map((t) =>
          this.toTaskRecord(ctx.state.baseWorkdir, t),
        );
        ctx.state.tasks.push(...newRecords);

        await this.emitEvent(ctx, {
          type: 'team.plan',
          isReplan: true,
          triggeredByTaskId: failedTask.id,
          tasks: validatedReplacements.map((t) => ({
            id: t.id,
            title: t.title,
            dependsOn: [...t.dependsOn],
            suggestedRole: t.suggestedRole,
          })),
        });
        return;
      } catch (err) {
        if (err instanceof PlanValidationError) {
          validationError = err.message;
          previousRawOutput = streamResult.output;
        } else {
          throw err;
        }
      }
    }
  }

  private async executeMergeAndFinalize(ctx: ActiveRunContext): Promise<void> {
    // Merge step: check all completed tasks for overlapping file paths
    const completedTasks = ctx.state.tasks.filter((t) => t.status === 'completed');

    for (const task of completedTasks) {
      const conflicts = this.detectTaskConflicts(ctx.state.tasks, task);
      const previouslyKnownPaths = new Set(task.conflicts.map((c) => c.path));
      const hasNewUnreviewedConflict = conflicts.some(
        (c) => !previouslyKnownPaths.has(c.path) || !task.conflictReviewed,
      );

      task.conflicts = conflicts;

      // If parallel tasks completed simultaneously and created an unreviewed path overlap, flag for reviewer
      if (conflicts.length > 0 && hasNewUnreviewedConflict && !ctx.budgetExceeded && !ctx.teamCancelled) {
        task.status = 'reviewing';
        await this.persist(ctx);
        await this.runReviewOnlyLifecycle(ctx, task, true);
      }
    }

    // If merge-conflict review rejected a task and queued a retry or replan, resume main scheduler loop
    if (ctx.state.tasks.some((t) => !this.isTerminalTaskStatus(t.status))) {
      return;
    }

    const mergeSummary = this.computeMergeSummary(ctx.state.tasks);
    ctx.state.mergeSummary = mergeSummary;

    const failedTasks = ctx.state.tasks.filter((t) => t.status === 'failed');
    const cancelledTasks = ctx.state.tasks.filter((t) => t.status === 'cancelled');
    const supersededTasks = ctx.state.tasks.filter((t) => t.status === 'superseded');

    // Determine whether all failed tasks had their dependents successfully replanned and completed
    const allCompletedTasks = ctx.state.tasks.filter((t) => t.status === 'completed');
    const unrecoveredFailures = failedTasks.filter((failed) => {
      const hadDependents = ctx.state.tasks.some((other) =>
        other.dependsOn.includes(failed.id),
      );
      if (!hadDependents) {
        return true;
      }
      // If replanning created replacement tasks and all non-superseded tasks succeeded, failure was recovered
      return supersededTasks.length === 0 || ctx.state.replansUsed === 0;
    });

    let finalStatus: Exclude<TeamStatus, 'planning' | 'running'> = 'completed';
    let reason: string | undefined;

    if (unrecoveredFailures.length > 0) {
      finalStatus = 'failed';
      reason = `Task(s) failed without recovery: ${unrecoveredFailures.map((t) => t.id).join(', ')}`;
    } else if (allCompletedTasks.length === 0 && cancelledTasks.length > 0) {
      finalStatus = 'cancelled';
      reason = 'All tasks were cancelled';
    }

    await this.finalizeTerminal(ctx, finalStatus, reason);
  }

  private async finalizeCancelled(ctx: ActiveRunContext): Promise<void> {
    const reason = ctx.teamCancelReason ?? 'Team cancelled';
    for (const task of ctx.state.tasks) {
      if (!this.isTerminalTaskStatus(task.status)) {
        task.status = 'cancelled';
      }
    }
    await this.finalizeTerminal(ctx, 'cancelled', reason);
  }

  private async finalizeBudgetExceeded(ctx: ActiveRunContext): Promise<void> {
    const reason = `Budget exceeded (tokens: ${ctx.state.usage.totalTokens}/${ctx.state.budget.maxTokens}, costUsd: $${ctx.state.usage.totalCostUsd.toFixed(4)}/$${ctx.state.budget.maxCostUsd.toFixed(4)})`;
    // Reset interrupted running tasks to pending so state can be resumed if budget is increased
    for (const task of ctx.state.tasks) {
      if (task.status === 'running') {
        task.status = 'pending';
        task.attempts = Math.max(0, task.attempts - 1);
      }
    }
    await this.finalizeTerminal(ctx, 'budget_exceeded', reason);
  }

  private async finalizeTerminal(
    ctx: ActiveRunContext,
    status: Exclude<TeamStatus, 'planning' | 'running'>,
    reason?: string,
  ): Promise<void> {
    if (this.isTerminalStatus(ctx.state.status)) {
      return;
    }

    if (!ctx.state.mergeSummary) {
      ctx.state.mergeSummary = this.computeMergeSummary(ctx.state.tasks);
    }

    ctx.state.status = status;
    ctx.state.terminalReason = reason;

    const doneEvent = this.buildDoneEvent(ctx.state, status, reason);
    await this.emitEvent(ctx, doneEvent);
  }

  private buildDoneEvent(
    state: TeamRunState,
    status: Exclude<TeamStatus, 'planning' | 'running'>,
    reason?: string,
  ): NewTeamEvent {
    const mergeSummary = state.mergeSummary ?? this.computeMergeSummary(state.tasks);
    return {
      type: 'team.done',
      status,
      reason,
      totalTokens: state.usage.totalTokens,
      totalCostUsd: state.usage.totalCostUsd,
      completedTaskIds: state.tasks
        .filter((t) => t.status === 'completed')
        .map((t) => t.id),
      failedTaskIds: state.tasks
        .filter((t) => t.status === 'failed')
        .map((t) => t.id),
      conflicts: mergeSummary.conflicts,
    };
  }

  private async consumeAgentStream(
    ctx: ActiveRunContext,
    request: AgentRunRequest,
  ): Promise<StreamConsumptionResult> {
    let intermediateTokens = 0;
    let intermediateCostUsd = 0;
    let accountedTokens = 0;
    let accountedCostUsd = 0;
    let lastResultOutput: string | null = null;
    let lastError: string | null = null;
    const changedFiles: string[] = [];

    const syncUsage = (runTokens: number, runCostUsd: number): void => {
      const deltaTokens = Math.max(0, runTokens - accountedTokens);
      const deltaCost = Math.max(0, runCostUsd - accountedCostUsd);
      accountedTokens += deltaTokens;
      accountedCostUsd += deltaCost;
      ctx.state.usage.totalTokens += deltaTokens;
      ctx.state.usage.totalCostUsd = Number(
        (ctx.state.usage.totalCostUsd + deltaCost).toFixed(10),
      );
    };

    const tripBudget = (): void => {
      ctx.budgetExceeded = true;
      ctx.plannerController?.abort();
      for (const controller of ctx.taskControllers.values()) {
        controller.abort();
      }
    };

    try {
      for await (const event of this.deps.runner.start(request)) {
        if (event.type === 'done') {
          const totalRunTokens = Math.max(intermediateTokens, event.tokens);
          const totalRunCost = Math.max(intermediateCostUsd, event.costUsd);
          syncUsage(totalRunTokens, totalRunCost);

          if (
            ctx.state.usage.totalTokens > ctx.state.budget.maxTokens ||
            ctx.state.usage.totalCostUsd > ctx.state.budget.maxCostUsd
          ) {
            tripBudget();
          }
          break;
        }

        intermediateTokens += event.tokens ?? 0;
        intermediateCostUsd += event.costUsd ?? 0;
        syncUsage(intermediateTokens, intermediateCostUsd);

        if (event.type === 'result') {
          lastResultOutput = event.output;
          if (event.changedFiles) {
            changedFiles.push(...event.changedFiles);
          }
        } else if (event.type === 'error') {
          lastError = event.message;
        }

        if (this.isBudgetReached(ctx.state)) {
          tripBudget();
          break;
        }
      }
    } catch (err) {
      if (!request.signal.aborted) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      output: lastResultOutput,
      changedFiles,
      error: lastError,
      aborted: request.signal.aborted,
    };
  }

  private getReadyTasks(tasks: TaskRecord[]): TaskRecord[] {
    const statusById = new Map<string, TaskRecord['status']>();
    for (const task of tasks) {
      statusById.set(task.id, task.status);
    }

    return tasks.filter((task) => {
      if (task.status !== 'pending') {
        return false;
      }
      return task.dependsOn.every((depId) => statusById.get(depId) === 'completed');
    });
  }

  private findTransitiveDependents(tasks: TaskRecord[], rootTaskId: string): TaskRecord[] {
    const affectedIds = new Set<string>();
    let added = true;

    while (added) {
      added = false;
      for (const task of tasks) {
        if (affectedIds.has(task.id) || task.id === rootTaskId) {
          continue;
        }
        const dependsOnAffected = task.dependsOn.some(
          (dep) => dep === rootTaskId || affectedIds.has(dep),
        );
        if (dependsOnAffected) {
          affectedIds.add(task.id);
          added = true;
        }
      }
    }

    return tasks.filter((t) => affectedIds.has(t.id));
  }

  private mergeTaskChangedFiles(task: TaskRecord, newPaths: string[]): void {
    const combined = new Set(task.changedFiles);
    for (const rawPath of newPaths) {
      const normalized = normalizeFilePath(rawPath);
      if (normalized.length > 0) {
        combined.add(normalized);
      }
    }
    task.changedFiles = Array.from(combined);
  }

  private detectTaskConflicts(allTasks: TaskRecord[], targetTask: TaskRecord): FileConflict[] {
    if (targetTask.changedFiles.length === 0) {
      return [];
    }

    const conflicts: FileConflict[] = [];
    for (const filePath of targetTask.changedFiles) {
      const otherTaskIds = allTasks
        .filter(
          (other) =>
            other.id !== targetTask.id &&
            other.status !== 'superseded' &&
            other.status !== 'cancelled' &&
            other.changedFiles.includes(filePath),
        )
        .map((other) => other.id);

      if (otherTaskIds.length > 0) {
        conflicts.push({
          path: filePath,
          otherTaskIds,
        });
      }
    }

    return conflicts;
  }

  private computeMergeSummary(allTasks: TaskRecord[]): MergeSummary {
    const completedTasks = allTasks.filter((t) => t.status === 'completed');
    const fileToTaskIds = new Map<string, string[]>();

    for (const task of completedTasks) {
      for (const filePath of task.changedFiles) {
        const list = fileToTaskIds.get(filePath) ?? [];
        list.push(task.id);
        fileToTaskIds.set(filePath, list);
      }
    }

    const mergedFiles = Array.from(fileToTaskIds.keys()).sort();
    const conflicts: FileConflict[] = [];

    for (const [filePath, taskIds] of fileToTaskIds.entries()) {
      if (taskIds.length > 1) {
        conflicts.push({
          path: filePath,
          otherTaskIds: taskIds,
        });
      }
    }

    conflicts.sort((a, b) => a.path.localeCompare(b.path));
    return { mergedFiles, conflicts };
  }

  private toTaskRecord(baseWorkdir: string, planTask: ValidatedPlanTask): TaskRecord {
    return {
      id: planTask.id,
      title: planTask.title,
      description: planTask.description,
      dependsOn: [...planTask.dependsOn],
      suggestedRole: planTask.suggestedRole,
      acceptanceCriteria: [...planTask.acceptanceCriteria],
      workdir: this.config.resolveWorkdir(baseWorkdir, planTask.id),
      status: 'pending',
      attempts: 0,
      retriesUsed: 0,
      humanInstructions: [],
      changedFiles: [],
      conflicts: [],
      conflictReviewed: false,
    };
  }

  private getRemainingBudget(state: TeamRunState) {
    return {
      remainingTokens: Math.max(0, state.budget.maxTokens - state.usage.totalTokens),
      remainingCostUsd: Math.max(
        0,
        Number((state.budget.maxCostUsd - state.usage.totalCostUsd).toFixed(10)),
      ),
    };
  }

  private isBudgetReached(state: TeamRunState): boolean {
    return (
      state.usage.totalTokens >= state.budget.maxTokens ||
      state.usage.totalCostUsd >= state.budget.maxCostUsd
    );
  }

  private isTerminalStatus(status: TeamStatus): boolean {
    return (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'budget_exceeded'
    );
  }

  private isTerminalTaskStatus(status: TaskRecord['status']): boolean {
    return (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'superseded'
    );
  }

  private async emitEvent(ctx: ActiveRunContext, eventBody: NewTeamEvent): Promise<TeamEvent> {
    ctx.state.lastEventSeq += 1;
    const timestamp = this.deps.clock.now();
    ctx.state.updatedAt = timestamp;

    const fullEvent = {
      seq: ctx.state.lastEventSeq,
      timestamp,
      runId: ctx.state.runId,
      ...eventBody,
    } as TeamEvent;

    ctx.state.events.push(fullEvent);

    const runListeners = this.listeners.get(ctx.state.runId);
    if (runListeners) {
      for (const listener of runListeners) {
        listener(structuredClone(fullEvent));
      }
    }

    await this.persist(ctx);
    return fullEvent;
  }

  private async persist(ctx: ActiveRunContext): Promise<void> {
    ctx.state.updatedAt = this.deps.clock.now();
    const snapshot = structuredClone(ctx.state);
    ctx.persistChain = ctx.persistChain.then(() => this.deps.store.save(snapshot));
    await ctx.persistChain;
  }

  private wake(ctx: ActiveRunContext): void {
    for (const resolve of ctx.wakeResolvers) {
      resolve();
    }
    ctx.wakeResolvers.clear();
  }

  private waitForWake(ctx: ActiveRunContext): Promise<void> {
    return new Promise<void>((resolve) => {
      ctx.wakeResolvers.add(resolve);
    });
  }

  private waitForProgress(ctx: ActiveRunContext): Promise<void> {
    if (ctx.inFlight.size === 0) {
      return Promise.resolve();
    }
    return Promise.race([
      ...ctx.inFlight.values(),
      this.waitForWake(ctx),
    ]);
  }
}
