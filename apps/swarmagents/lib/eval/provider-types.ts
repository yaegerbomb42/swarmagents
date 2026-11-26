// Multi-provider real-task desktop evaluation types.
//
// This benchmarks Claude Code + SwarmAgents solving *general tasks*
// (coding, web, file organization, GUI apps, non-vision desktop) against
// user-supplied providers. It is deliberately distinct from the harness
// A/B eval in this directory (suite.ts / driver.ts / comparator.ts), which
// compares *harness configurations* via scripted transcripts. Here the
// unit under test is the provider + the agent loop, and the metric is
// whether a real task gets completed.
//
// Determinism: the bundled `ScriptedProviderExecutor` replays a scripted,
// deterministic solve per task so the suite is stable in CI and in unit
// tests. A live executor can implement the same `ProviderExecutor` interface
// against the real runtime (see provider-executor.ts) for local Docker VM
// runs.

export type ProviderTaskCategory =
  | "coding"
  | "web"
  | "file-org"
  | "gui-app"
  | "non-vision-desktop";

/**
 * One scripted general task. The starting workspace is materialised into an
 * isolated run directory (or a VM /workspace when running against a VmDriver),
 * the executor works in it, and grading runs `node --test` on the verifier.
 */
export interface ProviderEvalTask {
  id: string;
  category: ProviderTaskCategory;
  title: string;
  description: string;
  /** The user request handed to the agent. */
  prompt: string;
  /** Starting workspace files, relative path -> content. */
  setupFiles: Record<string, string>;
  /** Grading test file (run with `node --test` in the run dir). */
  verifier: { path: string; content: string };
  /** The correct final state the scripted solve applies. */
  solution: ProviderSolution;
}

/** The final workspace delta a task's correct solve produces. */
export interface ProviderSolution {
  /** Files to write/overwrite, relative path -> content. */
  files: Record<string, string>;
  /** Relative paths to remove (e.g. originals superseded by a move). */
  deleted?: string[];
}

export interface ProviderRunMetrics {
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  wallClockMs: number;
}

export interface ProviderExecutorResult {
  /** Files the run left in the workspace (overlaid on the setup files). */
  files: Record<string, string>;
  /** Relative paths the run deleted from the workspace. */
  deleted?: string[];
  metrics: ProviderRunMetrics;
}

export interface ProviderRunContext {
  providerId: string;
  model: string;
}

/** Executes one task end to end against a provider. */
export interface ProviderExecutor {
  run(task: ProviderEvalTask, ctx: ProviderRunContext): Promise<ProviderExecutorResult>;
}

export interface ProviderTrialResult {
  taskId: string;
  category: ProviderTaskCategory;
  providerId: string;
  model: string;
  trial: number;
  resolved: boolean;
  partialScore: number;
  metrics: ProviderRunMetrics;
  grading: { passed: number; failed: number; total: number };
}

export interface ProviderReportRow {
  providerId: string;
  model: string;
  tasksRun: number;
  completionRate: number;
  meanTurns: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanWallClockMs: number;
}

export interface ProviderEvalReport {
  rows: ProviderReportRow[];
  generatedAt: string;
}
