import { z } from 'zod';

export const HARD_MAX_TASKS = 12;

export const PlanTaskSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'Task id must be non-empty')
    .max(64, 'Task id must be at most 64 characters'),
  title: z
    .string()
    .trim()
    .min(1, 'Task title must be non-empty')
    .max(200, 'Task title must be at most 200 characters'),
  description: z.string().trim().min(1, 'Task description must be non-empty'),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  suggestedRole: z
    .string()
    .trim()
    .min(1, 'suggestedRole must be non-empty')
    .max(64),
  acceptanceCriteria: z.union([
    z.string().trim().min(1, 'acceptanceCriteria must be non-empty'),
    z.array(z.string().trim().min(1)).min(1, 'acceptanceCriteria must have at least one criterion'),
  ]),
});

export const PlanSchema = z.object({
  tasks: z
    .array(PlanTaskSchema)
    .min(1, 'Plan must contain at least 1 task')
    .max(HARD_MAX_TASKS, `Plan cannot exceed ${HARD_MAX_TASKS} tasks`),
});

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(['accept', 'reject']),
  feedback: z.string().trim().optional(),
  conflictsResolved: z.boolean().optional(),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export interface ValidatedPlanTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  suggestedRole: string;
  acceptanceCriteria: string[];
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}

export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

export function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

export interface ValidateDagOptions {
  maxTasks?: number;
  existingValidTaskIds?: ReadonlySet<string>;
  existingAllTaskIds?: ReadonlySet<string>;
  forbiddenTaskIds?: ReadonlySet<string>;
  existingActiveCount?: number;
}

export function validatePlanDag(
  rawOutput: string,
  options: ValidateDagOptions = {},
): ValidatedPlanTask[] {
  const maxTasks = Math.min(options.maxTasks ?? HARD_MAX_TASKS, HARD_MAX_TASKS);
  const jsonText = extractJsonPayload(rawOutput);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PlanValidationError(`Invalid JSON syntax: ${detail}`);
  }

  const schemaResult = PlanSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new PlanValidationError(`Plan schema validation failed: ${issues}`);
  }

  const rawTasks = schemaResult.data.tasks;
  if (rawTasks.length > maxTasks) {
    throw new PlanValidationError(
      `Plan has ${rawTasks.length} tasks, exceeding maximum of ${maxTasks}`,
    );
  }

  const existingActiveCount = options.existingActiveCount ?? 0;
  if (existingActiveCount + rawTasks.length > HARD_MAX_TASKS) {
    throw new PlanValidationError(
      `Combined active task count (${existingActiveCount + rawTasks.length}) exceeds maximum of ${HARD_MAX_TASKS}`,
    );
  }

  const newTaskIds = new Set<string>();
  for (const task of rawTasks) {
    if (newTaskIds.has(task.id)) {
      throw new PlanValidationError(`Duplicate task id "${task.id}" in plan`);
    }
    if (options.existingAllTaskIds?.has(task.id)) {
      throw new PlanValidationError(`Task id "${task.id}" collides with an existing task id`);
    }
    newTaskIds.add(task.id);
  }

  const allowedDeps = new Set<string>([
    ...newTaskIds,
    ...(options.existingValidTaskIds ?? []),
  ]);

  const normalizedTasks: ValidatedPlanTask[] = rawTasks.map((task) => {
    const uniqueDeps = Array.from(new Set(task.dependsOn));
    for (const dep of uniqueDeps) {
      if (dep === task.id) {
        throw new PlanValidationError(`Task "${task.id}" cannot depend on itself`);
      }
      if (options.forbiddenTaskIds?.has(dep)) {
        throw new PlanValidationError(
          `Task "${task.id}" depends on failed or superseded task "${dep}"`,
        );
      }
      if (!allowedDeps.has(dep)) {
        throw new PlanValidationError(
          `Task "${task.id}" depends on unknown task "${dep}"`,
        );
      }
    }

    const criteria = Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria
      : [task.acceptanceCriteria];

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      dependsOn: uniqueDeps,
      suggestedRole: task.suggestedRole,
      acceptanceCriteria: criteria,
    };
  });

  // 3-color DFS cycle detection across the newly proposed subgraph
  const adjacency = new Map<string, string[]>();
  for (const task of normalizedTasks) {
    adjacency.set(
      task.id,
      task.dependsOn.filter((dep) => newTaskIds.has(dep)),
    );
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];

  const dfs = (nodeId: string): void => {
    visitState.set(nodeId, 'visiting');
    stack.push(nodeId);

    for (const depId of adjacency.get(nodeId) ?? []) {
      const state = visitState.get(depId);
      if (state === 'visiting') {
        const cycleStart = stack.indexOf(depId);
        const cyclePath = [...stack.slice(cycleStart), depId].join(' -> ');
        throw new PlanValidationError(`Dependency cycle detected: ${cyclePath}`);
      }
      if (state === undefined) {
        dfs(depId);
      }
    }

    stack.pop();
    visitState.set(nodeId, 'visited');
  };

  for (const task of normalizedTasks) {
    if (!visitState.has(task.id)) {
      dfs(task.id);
    }
  }

  return normalizedTasks;
}

export function parseReviewVerdict(rawOutput: string): ReviewVerdict {
  const jsonText = extractJsonPayload(rawOutput);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ReviewValidationError(`Invalid reviewer JSON syntax: ${detail}`);
  }

  const result = ReviewVerdictSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ReviewValidationError(`Reviewer schema validation failed: ${issues}`);
  }

  if (result.data.verdict === 'reject' && !result.data.feedback) {
    return {
      ...result.data,
      feedback: 'Reviewer rejected output without detailed feedback.',
    };
  }

  return result.data;
}
