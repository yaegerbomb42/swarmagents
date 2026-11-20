import { handleCreateTask, isClaimExpired, viewBoardTask } from "../board/handlers";
import { BoardUnavailableError, loadStore, withLockedStore } from "../board/store";
import { validatePollTasks } from "../board/validation";
import type { SwarmTask } from "../mcp-types";
import { getRuntimeManager, type RunStatus } from "../runtime/manager";
import { getRunSummary } from "../runtime/run-store";
import type { BoardAgentToolResult } from "./types";

type CreatedTask = { taskId: string; title: string };
type TaskListItem = Pick<SwarmTask, "id" | "title" | "status" | "claimedBy" | "prUrl">;
const BOARD_UNAVAILABLE = { ok: false, summary: "Board storage is temporarily unavailable. Try again shortly." };
const TASK_LIMIT = 20;
const DIGEST_SECTION_LIMIT = 5;

// The existing SwarmBoard is shared by its authenticated users: SwarmTask
// has no user owner. Conversation history and VM runs are private instead.
export async function createBoardTask(
  _userId: string,
  args: Record<string, unknown>,
): Promise<BoardAgentToolResult<CreatedTask>> {
  try {
    return await withLockedStore(async (store) => {
      const outcome = await handleCreateTask(store, {
        title: args.title,
        description: args.description,
        difficulty: args.difficulty === undefined ? "medium" : args.difficulty,
        constraints: args.constraints,
      }, "board-agent");
      if ("error" in outcome) {
        return outcome.error.code === -32602
          ? { ok: false, summary: outcome.error.message }
          : BOARD_UNAVAILABLE;
      }
      // handleCreateTask appends one task and persists it before returning success.
      const task = store.tasks[store.tasks.length - 1];
      return {
        ok: true,
        summary: `Created board task ${task.id}: ${task.title}.`,
        data: { taskId: task.id, title: task.title },
      };
    });
  } catch (err) {
    if (err instanceof BoardUnavailableError) return BOARD_UNAVAILABLE;
    throw err;
  }
}

function taskLine(task: TaskListItem): string {
  return `${task.id}: ${task.title} (${task.status})` +
    (task.claimedBy ? ` — assigned to ${task.claimedBy}` : "") +
    (task.prUrl ? ` — Reported PR: ${task.prUrl}` : "");
}

function excerpt(text: string, limit = 1000): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function listBoardTasks(
  _userId: string,
  { status }: { status?: unknown } = {},
): BoardAgentToolResult<TaskListItem[]> {
  const errors = validatePollTasks({ status });
  if (errors.length) return { ok: false, summary: errors[0].message };
  try {
    // MCP poll_tasks defaults to open and ranks for a worker. Chat shows all
    // statuses unless asked to filter, most recently updated first.
    const now = Date.now();
    const matches = loadStore().tasks.map((task) => viewBoardTask(task, now))
      .filter((task) => status == null || status === task.status);
    const data = matches.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, TASK_LIMIT)
      .map(({ id, title, status, claimedBy, prUrl }) => ({ id, title, status, claimedBy, prUrl }));
    const summary = data.length
      ? `Showing ${data.length} of ${matches.length} board tasks:\n${data.map(taskLine).join("\n")}`
      : "No matching board tasks.";
    return { ok: true, summary, data };
  } catch (err) {
    if (err instanceof BoardUnavailableError) return BOARD_UNAVAILABLE;
    throw err;
  }
}

/** A bounded snapshot of the board, not a prediction or a VM/Git status. */
export function getBoardDigest(): BoardAgentToolResult {
  try {
    const { tasks } = loadStore();
    const now = Date.now();
    const expired = tasks.filter((task) => isClaimExpired(task, now));
    const section = (heading: string, items: SwarmTask[], newestFirst = false) => {
      const rows = items.sort((a, b) => newestFirst ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt)
        .slice(0, DIGEST_SECTION_LIMIT).map(taskLine);
      const remaining = items.length - rows.length;
      return [`${heading} (${items.length})`, ...rows, ...(remaining ? [`…and ${remaining} more.`] : [])].join("\n");
    };
    return {
      ok: true,
      summary: [
        `Board digest: ${tasks.length} tasks`,
        `Open: ${tasks.filter((task) => task.status === "open").length + expired.length} · Active claims: ${tasks.filter((task) => task.status === "claimed").length - expired.length}`,
        section("Needs review", tasks.filter((task) => task.status === "in_review")),
        section("Blocked", tasks.filter((task) => task.status === "blocked")),
        section("Expired claims (ready to reclaim)", expired.map((task) => viewBoardTask(task, now))),
        section("Board-approved (Git merge not verified)", tasks.filter((task) => task.status === "completed"), true),
      ].join("\n\n"),
    };
  } catch (err) {
    if (err instanceof BoardUnavailableError) return BOARD_UNAVAILABLE;
    throw err;
  }
}

export function getBoardTask(_userId: string, taskId: unknown): BoardAgentToolResult<SwarmTask> {
  if (typeof taskId !== "string" || !taskId.trim()) return { ok: false, summary: "taskId is required." };
  try {
    const storedTask = loadStore().tasks.find((item) => item.id === taskId);
    if (!storedTask) return { ok: false, summary: "Board task not found." };
    const task = viewBoardTask(storedTask, Date.now());
    const summary = [
      taskLine(task),
      `Description: ${excerpt(task.description)}`,
      ...(task.resultSummary ? [`Reported result: ${excerpt(task.resultSummary)}`] : []),
    ].join("\n");
    return { ok: true, summary, data: task };
  } catch (err) {
    if (err instanceof BoardUnavailableError) return BOARD_UNAVAILABLE;
    throw err;
  }
}

export function getRunStatus(
  userId: string,
  runId: unknown,
): BoardAgentToolResult<{ runId: string; status: RunStatus }> {
  if (typeof runId !== "string" || !runId.trim()) return { ok: false, summary: "runId is required." };
  const run = getRuntimeManager().list(userId).find((item) => item.runId === runId && item.userId === userId);
  if (!run) return { ok: false, summary: "VM run not found." };

  const details = [`VM run ${run.runId}: ${run.status}.`];
  if (run.position !== undefined && run.status === "queued") details.push(`Queue position: ${run.position}.`);
  if (run.exitCode !== undefined) details.push(`Exit code: ${run.exitCode}.`);
  if (run.error) details.push(excerpt(run.error));
  if (run.status === "finished" || run.status === "error" || run.status === "cancelled") {
    // The manager's live view has no final assistant text. After verifying
    // ownership above, enrich it with the existing persisted run summary.
    const saved = getRunSummary(run.runId);
    if (saved?.userId === userId && saved.finalText) details.push(`Run output (unverified): ${excerpt(saved.finalText)}`);
  }
  return { ok: true, summary: details.join("\n"), data: { runId: run.runId, status: run.status } };
}
