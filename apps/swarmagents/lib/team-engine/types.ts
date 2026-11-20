export interface AgentBudget {
  remainingTokens: number;
  remainingCostUsd: number;
}

export interface AgentRunRequest {
  runId: string;
  taskId?: string;
  attempt?: number;
  role: string;
  prompt: string;
  workdir: string;
  budget: AgentBudget;
  signal: AbortSignal;
}

export type AgentStreamEvent =
  | { type: 'thinking'; content: string; tokens?: number; costUsd?: number }
  | { type: 'tool'; name: string; input?: unknown; output?: unknown; tokens?: number; costUsd?: number }
  | { type: 'result'; output: string; changedFiles?: string[]; tokens?: number; costUsd?: number }
  | { type: 'error'; message: string; retryable?: boolean; tokens?: number; costUsd?: number }
  | { type: 'done'; tokens: number; costUsd: number };

export interface AgentRunner {
  start(request: AgentRunRequest): AsyncIterable<AgentStreamEvent>;
}

export interface Clock {
  now(): number;
}

export interface Store {
  load(runId: string): Promise<TeamRunState | null>;
  save(state: TeamRunState): Promise<void>;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'reviewing'
  | 'paused_human'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export interface FileConflict {
  path: string;
  otherTaskIds: string[];
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  suggestedRole: string;
  acceptanceCriteria: string[];
  workdir: string;
  status: TaskStatus;
  attempts: number;
  retriesUsed: number;
  lastResult?: string;
  lastFeedback?: string;
  lastError?: string;
  pauseReason?: string;
  humanInstructions: string[];
  changedFiles: string[];
  conflicts: FileConflict[];
  conflictReviewed: boolean;
}

export interface PlannedTaskSummary {
  id: string;
  title: string;
  dependsOn: string[];
  suggestedRole: string;
}

export type TeamStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

interface BaseTeamEvent {
  seq: number;
  timestamp: number;
  runId: string;
}

export type TeamEvent =
  | (BaseTeamEvent & {
      type: 'team.plan';
      isReplan: boolean;
      triggeredByTaskId?: string;
      tasks: PlannedTaskSummary[];
    })
  | (BaseTeamEvent & {
      type: 'task.started';
      taskId: string;
      title: string;
      role: string;
      attempt: number;
      workdir: string;
    })
  | (BaseTeamEvent & {
      type: 'task.review';
      taskId: string;
      attempt: number;
      verdict: 'accept' | 'reject';
      feedback?: string;
      conflicts: FileConflict[];
    })
  | (BaseTeamEvent & {
      type: 'task.retry';
      taskId: string;
      nextAttempt: number;
      reason: string;
    })
  | (BaseTeamEvent & {
      type: 'task.failed';
      taskId: string;
      attempts: number;
      reason: string;
    })
  | (BaseTeamEvent & {
      type: 'task.paused';
      taskId: string;
      reason?: string;
    })
  | (BaseTeamEvent & {
      type: 'task.resumed';
      taskId: string;
      mode: 'human_result' | 'agent_with_instructions';
    })
  | (BaseTeamEvent & {
      type: 'task.cancelled';
      taskId: string;
      reason?: string;
    })
  | (BaseTeamEvent & {
      type: 'team.done';
      status: Exclude<TeamStatus, 'planning' | 'running'>;
      reason?: string;
      totalTokens: number;
      totalCostUsd: number;
      completedTaskIds: string[];
      failedTaskIds: string[];
      conflicts: FileConflict[];
    });

export type NewTeamEvent =
  TeamEvent extends infer E
    ? E extends BaseTeamEvent
      ? Omit<E, 'seq' | 'timestamp' | 'runId'>
      : never
    : never;

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
}

export interface BudgetUsage {
  totalTokens: number;
  totalCostUsd: number;
}

export interface MergeSummary {
  mergedFiles: string[];
  conflicts: FileConflict[];
}

export interface TeamRunState {
  runId: string;
  goal: string;
  baseWorkdir: string;
  status: TeamStatus;
  terminalReason?: string;
  budget: BudgetLimits;
  usage: BudgetUsage;
  planAttempts: number;
  replansUsed: number;
  tasks: TaskRecord[];
  mergeSummary?: MergeSummary;
  events: TeamEvent[];
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorDependencies {
  runner: AgentRunner;
  clock: Clock;
  store: Store;
}

export interface OrchestratorConfig {
  maxConcurrency: number;
  maxTasks: number;
  maxPlanRetries: number;
  maxTaskRetries: number;
  maxReplans: number;
  plannerRole: string;
  reviewerRole: string;
  resolveWorkdir: (baseWorkdir: string, taskId: string) => string;
}

export interface RunTeamOptions {
  runId: string;
  goal: string;
  baseWorkdir: string;
  budget: BudgetLimits;
  maxConcurrency?: number;
  returnWhenPaused?: boolean;
}

export interface ResumeTeamOptions {
  budgetOverride?: BudgetLimits;
  maxConcurrency?: number;
  returnWhenPaused?: boolean;
}

export interface HumanTakeoverInput {
  result?: string;
  changedFiles?: string[];
  instructions?: string;
  skipReview?: boolean;
}

export type TeamEventListener = (event: TeamEvent) => void;
