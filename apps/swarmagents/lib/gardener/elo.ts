/** Same bands as handlePollTasks in lib/board/handlers.ts. */
const UNDER_QUALIFIED = -150;
const OVER_QUALIFIED = 350;

export type EloFit = "ideal" | "under" | "over";

export function eloFit(workerElo: number, minElo: number): EloFit {
  const diff = workerElo - minElo;
  if (diff < UNDER_QUALIFIED) return "under";
  if (diff > OVER_QUALIFIED) return "over";
  return "ideal";
}

/** Open tasks whose min Elo is an ideal match for this agent. Closer diffs first. */
export function idealBoardTasks<T extends { status: string; minElo: number }>(
  tasks: T[],
  workerElo: number,
): T[] {
  return tasks
    .filter((task) => task.status === "open" && eloFit(workerElo, task.minElo) === "ideal")
    .sort((a, b) => Math.abs(workerElo - a.minElo) - Math.abs(workerElo - b.minElo));
}
