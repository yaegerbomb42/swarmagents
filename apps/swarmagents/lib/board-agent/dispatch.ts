import { makeRedactor } from "../harness/redact";
import type { SwarmTask } from "../mcp-types";
import { getRuntimeManager } from "../runtime/manager";

const redact = makeRedactor();

export function dispatchTaskToVm(userId: string, task: SwarmTask): { runId: string } | { error: string } {
  const prompt = [
    `Work on SwarmBoard task ${task.id}: ${task.title}`,
    "Use a scratch worktree. Fetch origin and start your branch from the current tip of origin/feat/l1-Ace-1-library-store. If checks pass, open a PR targeting feat/l1-Ace-1-library-store. Do not merge or deploy, and do not open or modify api_keys.md or expose credentials.",
    `Task description:\n${task.description}`,
    ...(task.constraints.length ? [`Task constraints:\n${task.constraints.map((constraint) => `- ${constraint}`).join("\n")}`] : []),
    "Report what changed, what you verified, and the PR URL if you opened one. Do not claim an action succeeded unless it did.",
  ].join("\n\n");
  try {
    const result = getRuntimeManager().start(userId, { prompt, computeTarget: "cloud", freshSession: true });
    if (!result.accepted) {
      return {
        error: result.error
          ? redact(result.error).slice(0, 500)
          : `The VM run queue is full (max ${result.limit ?? 3}). Wait for a run to finish.`,
      };
    }
    return { runId: result.runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    return { error: redact(message).slice(0, 500) || "The VM runtime is unavailable." };
  }
}
