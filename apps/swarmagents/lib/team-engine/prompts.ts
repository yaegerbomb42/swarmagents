import type { FileConflict, TaskRecord } from './types';

export function buildPlannerPrompt(params: {
  goal: string;
  baseWorkdir: string;
  maxTasks: number;
  validationError?: string;
  previousRawOutput?: string;
}): string {
  const sections: string[] = [
    `You are the Lead Planner for an autonomous engineering team.`,
    `Goal: ${params.goal}`,
    `Workspace root: ${params.baseWorkdir}`,
    ``,
    `Decompose the goal into an acyclic dependency graph (DAG) of at most ${params.maxTasks} concrete tasks.`,
    `Return ONLY valid JSON matching this exact schema (no markdown commentary outside JSON):`,
    `{`,
    `  "tasks": [`,
    `    {`,
    `      "id": "string (unique slug)",`,
    `      "title": "string",`,
    `      "description": "string",`,
    `      "dependsOn": ["upstream-task-id"],`,
    `      "suggestedRole": "string (e.g. backend, frontend, tester, researcher)",`,
    `      "acceptanceCriteria": ["criterion 1", "criterion 2"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Maximum ${params.maxTasks} tasks.`,
    `- Strictly acyclic DAG (no cycles or self-dependencies).`,
    `- Maximise safe parallelism for independent tasks.`,
    `- Every task must have verifiable acceptanceCriteria.`,
  ];

  if (params.validationError) {
    sections.push(
      ``,
      `PREVIOUS OUTPUT WAS INVALID AND REJECTED:`,
      `Validation Error: ${params.validationError}`,
      params.previousRawOutput ? `Previous Output:\n${params.previousRawOutput}` : '',
      `Fix the JSON/DAG error and return ONLY valid JSON.`,
    );
  }

  return sections.filter((line) => line !== undefined).join('\n');
}

export function buildReplanPrompt(params: {
  goal: string;
  baseWorkdir: string;
  maxNewTasks: number;
  failedTask: TaskRecord;
  completedTasks: TaskRecord[];
  supersededTasks: TaskRecord[];
  remainingActiveTasks: TaskRecord[];
  validationError?: string;
  previousRawOutput?: string;
}): string {
  const completedSummary =
    params.completedTasks.length > 0
      ? params.completedTasks
          .map((t) => `- ${t.id} (${t.title}): ${t.lastResult ?? 'completed'}`)
          .join('\n')
      : '(none)';

  const supersededSummary = params.supersededTasks
    .map((t) => `- ${t.id} (${t.title}): ${t.description}`)
    .join('\n');

  const activeSummary =
    params.remainingActiveTasks.length > 0
      ? params.remainingActiveTasks
          .map((t) => `- ${t.id} (${t.title}) [${t.status}]`)
          .join('\n')
      : '(none)';

  const sections: string[] = [
    `You are the Lead Planner performing dynamic replanning after a task failure.`,
    `Goal: ${params.goal}`,
    `Workspace root: ${params.baseWorkdir}`,
    ``,
    `Failed Task:`,
    `- ${params.failedTask.id} (${params.failedTask.title}): failed after ${params.failedTask.attempts} attempts. Reason: ${params.failedTask.lastFeedback ?? params.failedTask.lastError ?? 'unknown'}`,
    ``,
    `Completed Tasks (already finished; DO NOT recreate these IDs):`,
    completedSummary,
    ``,
    `Remaining Active Tasks (already scheduled; DO NOT recreate these IDs):`,
    activeSummary,
    ``,
    `Superseded Dependent Tasks (blocked by failed task; replace their objectives with an alternative plan):`,
    supersededSummary,
    ``,
    `Return ONLY valid JSON with replacement tasks (at most ${params.maxNewTasks} tasks):`,
    `{`,
    `  "tasks": [`,
    `    {`,
    `      "id": "string (new unique slug)",`,
    `      "title": "string",`,
    `      "description": "string",`,
    `      "dependsOn": ["completed-or-active-or-new-task-id"],`,
    `      "suggestedRole": "string",`,
    `      "acceptanceCriteria": ["criterion 1"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Do NOT depend on failed task "${params.failedTask.id}" or any superseded task IDs.`,
    `- You MAY depend on any completed task ID, remaining active task ID, or newly defined task ID.`,
    `- Strictly acyclic DAG, at most ${params.maxNewTasks} new tasks.`,
  ];

  if (params.validationError) {
    sections.push(
      ``,
      `PREVIOUS REPLAN OUTPUT WAS INVALID:`,
      `Validation Error: ${params.validationError}`,
      params.previousRawOutput ? `Previous Output:\n${params.previousRawOutput}` : '',
      `Fix the JSON/DAG error and return ONLY valid JSON.`,
    );
  }

  return sections.join('\n');
}

export function buildWorkerPrompt(params: {
  goal: string;
  task: TaskRecord;
  attempt: number;
  dependencyOutputs: Array<{ id: string; title: string; output: string; changedFiles: string[] }>;
}): string {
  const sections: string[] = [
    `Overall Team Goal: ${params.goal}`,
    `Assigned Task [${params.task.id}] (Attempt ${params.attempt}): ${params.task.title}`,
    `Role: ${params.task.suggestedRole}`,
    `Working Directory: ${params.task.workdir}`,
    ``,
    `Task Description:`,
    params.task.description,
    ``,
    `Acceptance Criteria:`,
    ...params.task.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`),
  ];

  if (params.dependencyOutputs.length > 0) {
    sections.push(``, `Completed Upstream Dependencies:`);
    for (const dep of params.dependencyOutputs) {
      sections.push(
        `- [${dep.id}] ${dep.title}: ${dep.output}` +
          (dep.changedFiles.length > 0 ? ` (changed files: ${dep.changedFiles.join(', ')})` : ''),
      );
    }
  }

  if (params.task.lastFeedback) {
    sections.push(
      ``,
      `REVIEWER FEEDBACK FROM PREVIOUS ATTEMPT (MUST ADDRESS):`,
      params.task.lastFeedback,
    );
  } else if (params.task.lastError) {
    sections.push(
      ``,
      `ERROR FROM PREVIOUS ATTEMPT (MUST RESOLVE):`,
      params.task.lastError,
    );
  }

  if (params.task.humanInstructions.length > 0) {
    sections.push(
      ``,
      `HUMAN OPERATOR INSTRUCTIONS:`,
      ...params.task.humanInstructions.map((inst, i) => `${i + 1}. ${inst}`),
    );
  }

  return sections.join('\n');
}

export function buildReviewerPrompt(params: {
  goal: string;
  task: TaskRecord;
  attempt: number;
  workerOutput: string;
  changedFiles: string[];
  conflicts: FileConflict[];
  isMergeConflictPass?: boolean;
}): string {
  const sections: string[] = [
    params.isMergeConflictPass
      ? `You are the Quality & Merge Reviewer performing a merge-conflict verification pass.`
      : `You are the Quality Reviewer evaluating a completed task against its acceptance criteria.`,
    `Overall Team Goal: ${params.goal}`,
    `Task [${params.task.id}] (Attempt ${params.attempt}): ${params.task.title}`,
    `Description: ${params.task.description}`,
    ``,
    `Acceptance Criteria:`,
    ...params.task.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`),
    ``,
    `Submitted Output:`,
    params.workerOutput,
    ``,
    `Changed Files: ${params.changedFiles.length > 0 ? params.changedFiles.join(', ') : '(none)'}`,
  ];

  if (params.conflicts.length > 0) {
    sections.push(
      ``,
      `MERGE CONFLICT ALERT — OVERLAPPING FILE PATHS DETECTED:`,
      ...params.conflicts.map(
        (c) => `- Path "${c.path}" was also modified by task(s): ${c.otherTaskIds.join(', ')}`,
      ),
      `Verify whether these concurrent file edits conflict or require rework before accepting.`,
    );
  }

  sections.push(
    ``,
    `Return ONLY valid JSON matching:`,
    `{`,
    `  "verdict": "accept" | "reject",`,
    `  "feedback": "specific actionable feedback (required when verdict is reject)",`,
    `  "conflictsResolved": true | false`,
    `}`,
  );

  return sections.join('\n');
}
