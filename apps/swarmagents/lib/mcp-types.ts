export type TaskDifficulty = "easy" | "medium" | "hard";

export type TaskStatus = "open" | "claimed" | "in_review" | "completed" | "blocked";

/**
 * One auditable status change on a board task. Appended by every mutating
 * handler so a task's lifecycle is visible in poll and GET output. For new
 * tasks `none → open` records creation; legacy tasks need not have that
 * entry. `claimed → open` by the board records claim expiry.
 */
export interface TaskTransition {
  from: TaskStatus | "none";
  to: TaskStatus;
  actor: string;
  at: number;
}

export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  difficulty: TaskDifficulty;
  constraints: string[];
  status: TaskStatus;
  claimedBy?: string;
  resultSummary?: string;
  gitBranch?: string;
  prUrl?: string;
  /** Reviewer recorded by review_and_merge_task (approve or reject). */
  reviewedBy?: string;
  /** Epoch ms of the last review_and_merge_task decision. */
  reviewedAt?: number;
  /** Append-only status transition log for audit. Older tasks may omit it. */
  history?: TaskTransition[];
  createdAt: number;
  updatedAt: number;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

/**
 * One orchestrator decision on a proposal. Decisions are append-only (a
 * proposal can only be judged while pending) so the full judgement history
 * survives; `orchestratorFeedback` mirrors the latest decision for older
 * clients that predate this field.
 */
export interface ProposalDecision {
  approved: boolean;
  feedback?: string;
  actor: string;
  at: number;
}

export interface TaskProposal {
  id: string;
  proposedBy: string;
  title: string;
  problem: string;
  proposedSolution: string;
  suggestedDifficulty: TaskDifficulty;
  status: ProposalStatus;
  orchestratorFeedback?: string;
  /** Append-only judgement log. Older proposals may omit it. */
  decisions?: ProposalDecision[];
  promotedTaskId?: string;
  createdAt: number;
}

export interface SwarmMessage {
  id: string;
  fromAgent: string;
  channel: "general" | "blockers" | "announcements" | "idle_scouts";
  content: string;
  timestamp: number;
}

/** Difficulty order, easiest first. Used to sort polls and to compare a
 * gardener's max difficulty against a task's difficulty. */
export const DIFFICULTY_RANK: Record<TaskDifficulty, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
};

export type VmMcpToolName =
  | "vm_exec"
  | "vm_read_output"
  | "vm_read_file"
  | "vm_write_file"
  | "vm_list_workspace"
  | "vm_screenshot";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface VmExecArgs {
  cmd: string | string[];
  waitMs?: number;
}

export interface VmExecResult {
  runId: string;
  command: string;
  status: "running" | "finished" | "error" | "cancelled";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
  lastSeq?: number;
  truncated?: boolean;
}

export interface VmReadOutputArgs {
  runId: string;
  fromSeq?: number;
  waitMs?: number;
}

export interface VmReadOutputResult {
  runId: string;
  status: string;
  exitCode?: number;
  error?: string;
  stdout: string;
  stderr: string;
  output: string;
  lastSeq: number;
  truncated: boolean;
}

export interface VmReadFileArgs {
  path: string;
}

export interface VmReadFileResult {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  limit: number;
  content?: string;
}

export interface VmWriteFileArgs {
  path: string;
  content: string;
}

export interface VmWriteFileResult {
  path: string;
  bytesWritten: number;
}

export interface VmListWorkspaceArgs {
  path?: string;
}

export interface VmWorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  modifiedAt?: number;
}

export interface VmListWorkspaceResult {
  path: string;
  root: string;
  parent: string | null;
  entries: VmWorkspaceEntry[];
}

export type VmScreenshotArgs = Record<string, never>;

export interface VmScreenshotResult {
  mimeType: "image/png";
  bytes: number;
  dataBase64: string;
}

/** Map a legacy difficulty (trivial/expert) onto the current three levels. */
export function normalizeDifficulty(value: unknown): TaskDifficulty {
  if (value === "trivial" || value === "easy") return "easy";
  if (value === "expert" || value === "hard") return "hard";
  return "medium";
}
