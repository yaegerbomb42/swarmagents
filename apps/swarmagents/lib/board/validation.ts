import type { TaskDifficulty } from "@/lib/mcp-types";

const DIFFICULTIES: TaskDifficulty[] = ["trivial", "easy", "medium", "hard", "expert"];
const STATUSES = ["open", "claimed", "in_review", "completed", "blocked"] as const;
const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;

export type ValidationError = { field: string; message: string };

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function requiredString(v: unknown, field: string, maxLenCap?: number): ValidationError | null {
  if (!isString(v) || v.trim().length === 0) {
    return { field, message: `${field} is required and must be a non-empty string` };
  }
  if (maxLenCap !== undefined && v.length > maxLenCap) {
    return { field, message: `${field} exceeds maximum length of ${maxLenCap}` };
  }
  return null;
}

function optionalString(v: unknown, field: string, maxLenCap?: number): ValidationError | null {
  if (v === undefined || v === null) return null;
  if (!isString(v)) return { field, message: `${field} must be a string` };
  if (maxLenCap !== undefined && v.length > maxLenCap) {
    return { field, message: `${field} exceeds maximum length of ${maxLenCap}` };
  }
  return null;
}

function requiredEnum<T extends string>(v: unknown, field: string, values: readonly T[]): ValidationError | null {
  if (!isString(v) || !values.includes(v as T)) {
    return { field, message: `${field} must be one of ${values.join(", ")}` };
  }
  return null;
}

function optionalEnum<T extends string>(v: unknown, field: string, values: readonly T[]): ValidationError | null {
  if (v === undefined || v === null) return null;
  return requiredEnum(v, field, values);
}

function requiredNumber(v: unknown, field: string): ValidationError | null {
  if (!isNumber(v)) return { field, message: `${field} is required and must be a number` };
  return null;
}

function optionalNumber(v: unknown, field: string): ValidationError | null {
  if (v === undefined || v === null) return null;
  if (!isNumber(v)) return { field, message: `${field} must be a number` };
  return null;
}

function requiredBoolean(v: unknown, field: string): ValidationError | null {
  if (!isBoolean(v)) return { field, message: `${field} is required and must be a boolean` };
  return null;
}

function optionalBoolean(v: unknown, field: string): ValidationError | null {
  if (v === undefined || v === null) return null;
  if (!isBoolean(v)) return { field, message: `${field} must be a boolean` };
  return null;
}

export function validateCreateTask(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.title, "title", 200);
  if (e1) errs.push(e1);
  const e2 = requiredString(args.description, "description", 8000);
  if (e2) errs.push(e2);
  const e3 = requiredEnum(args.difficulty, "difficulty", DIFFICULTIES);
  if (e3) errs.push(e3);
  if (args.constraints !== undefined && !isStringArray(args.constraints)) {
    errs.push({ field: "constraints", message: "constraints must be an array of strings" });
  }
  if (args.constraints && isStringArray(args.constraints)) {
    for (const c of args.constraints) {
      if (c.length > 500) {
        errs.push({ field: "constraints", message: "each constraint must not exceed 500 characters" });
        break;
      }
    }
  }
  return errs;
}

export function validatePollTasks(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = optionalEnum(args.status, "status", STATUSES);
  if (e1) errs.push(e1);
  const e2 = optionalNumber(args.workerElo, "workerElo");
  if (e2) errs.push(e2);
  return errs;
}

export function validateListProposals(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = optionalEnum(args.status, "status", PROPOSAL_STATUSES);
  if (e1) errs.push(e1);
  return errs;
}

export function validateClaimTask(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.taskId, "taskId");
  if (e1) errs.push(e1);
  const e2 = requiredString(args.agentName, "agentName", 200);
  if (e2) errs.push(e2);
  const e3 = requiredNumber(args.workerElo, "workerElo");
  if (e3) errs.push(e3);
  return errs;
}

export function validateSubmitTaskWork(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.taskId, "taskId");
  if (e1) errs.push(e1);
  // Ownership is now enforced: the caller must name the agent that claimed the
  // task. Keep this message explicit — it is the migration hint for clients
  // (orchestration scripts) that called submit_task_work without agentName.
  if (!isString(args.agentName) || args.agentName.trim().length === 0) {
    errs.push({
      field: "agentName",
      message:
        "agentName is required — pass the exact agentName that claimed this task (submit_task_work is owner-only)",
    });
  } else if (args.agentName.length > 200) {
    errs.push({ field: "agentName", message: "agentName exceeds maximum length of 200" });
  }
  const e2 = requiredString(args.gitBranch, "gitBranch", 200);
  if (e2) errs.push(e2);
  const e3 = requiredString(args.summary, "summary", 8000);
  if (e3) errs.push(e3);
  const e4 = optionalString(args.prUrl, "prUrl", 500);
  if (e4) errs.push(e4);
  return errs;
}

export function validateRecordMatch(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const winner = requiredString(args.winner, "winner", 160);
  if (winner) errs.push(winner);
  const loser = requiredString(args.loser, "loser", 160);
  if (loser) errs.push(loser);
  const reason = optionalString(args.reason, "reason", 200);
  if (reason) errs.push(reason);

  for (const field of ["winnerScore", "loserScore", "winnerLatencyMs", "loserLatencyMs", "winnerCostUsd", "loserCostUsd"] as const) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (!isNumber(value)) {
      errs.push({ field, message: `${field} must be a number` });
    } else if (value < 0) {
      errs.push({ field, message: `${field} must be non-negative` });
    }
  }
  return errs;
}

export function validateSyncArtifact(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  for (const field of ["runId", "agentId", "taskId", "computeTarget", "summary"] as const) {
    const error = requiredString(args[field], field, field === "summary" ? 500 : 160);
    if (error) errs.push(error);
  }
  if (!Array.isArray(args.files) || args.files.some((file) => typeof file !== "string" || file.length > 300)) {
    errs.push({ field: "files", message: "files must be an array of strings" });
  } else if (args.files.length > 50) {
    errs.push({ field: "files", message: "files accepts at most 50 entries" });
  }
  return errs;
}

export function validateListArtifacts(args: Record<string, unknown>): ValidationError[] {
  if (args.runId === undefined) return [];
  const error = requiredString(args.runId, "runId", 160);
  return error ? [error] : [];
}

export function validateSubmitProposal(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.proposedBy, "proposedBy", 200);
  if (e1) errs.push(e1);
  const e2 = requiredString(args.title, "title", 200);
  if (e2) errs.push(e2);
  const e3 = requiredString(args.problem, "problem", 8000);
  if (e3) errs.push(e3);
  const e4 = requiredString(args.proposedSolution, "proposedSolution", 8000);
  if (e4) errs.push(e4);
  const e5 = requiredEnum(args.suggestedDifficulty, "suggestedDifficulty", DIFFICULTIES);
  if (e5) errs.push(e5);
  return errs;
}

export function validateJudgeProposal(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.proposalId, "proposalId");
  if (e1) errs.push(e1);
  const e2 = requiredBoolean(args.approved, "approved");
  if (e2) errs.push(e2);
  const e3 = optionalString(args.feedback, "feedback", 8000);
  if (e3) errs.push(e3);
  const e4 = optionalEnum(args.finalDifficulty, "finalDifficulty", DIFFICULTIES);
  if (e4) errs.push(e4);
  const e5 = optionalString(args.actor, "actor", 200);
  if (e5) errs.push(e5);
  return errs;
}

export function validateReviewAndMergeTask(args: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const e1 = requiredString(args.taskId, "taskId");
  if (e1) errs.push(e1);
  const e2 = requiredBoolean(args.approved, "approved");
  if (e2) errs.push(e2);
  const e3 = requiredString(args.feedback, "feedback", 8000);
  if (e3) errs.push(e3);
  const e4 = optionalBoolean(args.autoMergeGit, "autoMergeGit");
  if (e4) errs.push(e4);
  const e5 = optionalString(args.reviewer, "reviewer", 200);
  if (e5) errs.push(e5);
  return errs;
}
