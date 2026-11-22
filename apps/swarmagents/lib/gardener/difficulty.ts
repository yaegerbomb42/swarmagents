import type { TaskDifficulty } from "../mcp-types";
import { DIFFICULTY_RANK, normalizeDifficulty } from "../mcp-types";

/** A task fits when its difficulty is at or below the gardener's max. */
export function fitsDifficulty(difficulty: TaskDifficulty, maxDifficulty: TaskDifficulty): boolean {
  return DIFFICULTY_RANK[normalizeDifficulty(difficulty)] <= DIFFICULTY_RANK[normalizeDifficulty(maxDifficulty)];
}

/** Open tasks within the max difficulty, easiest first, then newest first. */
export function tasksWithinDifficulty<T extends { status: string; difficulty: TaskDifficulty; updatedAt?: number }>(
  tasks: T[],
  maxDifficulty: TaskDifficulty,
): T[] {
  return tasks
    .filter((task) => task.status === "open" && fitsDifficulty(task.difficulty, maxDifficulty))
    .sort(
      (a, b) =>
        DIFFICULTY_RANK[normalizeDifficulty(a.difficulty)] -
          DIFFICULTY_RANK[normalizeDifficulty(b.difficulty)] ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
}
