import type { BoardTaskInput, GardenerProposal, HotspotInput } from "./types";

/** Matches minimalist-ui LOW_COVERAGE_PCT. */
export const LOW_COVERAGE_PCT = 50;

function proposalId(parts: string[]): string {
  return parts.join(":");
}

/**
 * Coverage gaps and hot files become proposals. Nothing is applied until
 * the user approves. Existing awaiting/approved rows are not duplicated.
 */
export function proposalsFromAnalysis(input: {
  userId: string;
  repoRoot: string;
  hotspots: HotspotInput[];
  now: number;
  existing: GardenerProposal[];
}): GardenerProposal[] {
  const taken = new Set(
    input.existing
      .filter((p) => p.status !== "dismissed")
      .map((p) => proposalId([p.kind, p.repoRoot ?? "", p.path ?? "", p.taskId ?? ""])),
  );
  const out: GardenerProposal[] = [];
  const ranked = [...input.hotspots].sort((a, b) => b.heat - a.heat);

  for (const file of ranked) {
    const low = file.coveragePct == null || file.coveragePct <= LOW_COVERAGE_PCT;
    if (!low) continue;
    const id = proposalId(["unit-test", input.repoRoot, file.path, ""]);
    if (taken.has(id)) continue;
    taken.add(id);
    const coverage =
      file.coveragePct == null ? "no coverage artifact" : `${file.coveragePct}% lines`;
    out.push({
      id: `prop_${input.now.toString(36)}_${out.length}_test`,
      userId: input.userId,
      kind: "unit-test",
      title: `Missing unit tests: ${file.path}`,
      summary: `${file.path} is a hotspot (heat ${file.heat.toFixed(2)}) with ${coverage}. A unit-test PR is waiting for one-click approval.`,
      repoRoot: input.repoRoot,
      path: file.path,
      status: "awaiting_approval",
      createdAt: input.now,
    });
  }

  const top = ranked[0];
  if (top) {
    const id = proposalId(["pr", input.repoRoot, top.path, ""]);
    if (!taken.has(id)) {
      out.push({
        id: `prop_${input.now.toString(36)}_${out.length}_pr`,
        userId: input.userId,
        kind: "pr",
        title: `Review hotspot: ${top.path}`,
        summary: `${top.path} leads the heatmap (heat ${top.heat.toFixed(2)}). A pull request is proposed and waits for one-click approval.`,
        repoRoot: input.repoRoot,
        path: top.path,
        status: "awaiting_approval",
        createdAt: input.now,
      });
    }
  }
  return out;
}

export function proposalsFromBoard(input: {
  userId: string;
  tasks: BoardTaskInput[];
  now: number;
  existing: GardenerProposal[];
}): GardenerProposal[] {
  const taken = new Set(
    input.existing.filter((p) => p.status !== "dismissed" && p.taskId).map((p) => p.taskId as string),
  );
  const out: GardenerProposal[] = [];
  for (const task of input.tasks) {
    if (taken.has(task.id)) continue;
    out.push({
      id: `prop_${input.now.toString(36)}_${out.length}_board`,
      userId: input.userId,
      kind: "board-task",
      title: task.title,
      summary: task.description?.trim()
        ? task.description.trim()
        : `Open swarm-board task ${task.id} (difficulty: ${task.difficulty}). Claim waits for one-click approval.`,
      taskId: task.id,
      difficulty: task.difficulty,
      status: "awaiting_approval",
      createdAt: input.now,
    });
  }
  return out;
}
