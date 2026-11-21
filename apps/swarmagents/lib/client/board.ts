/**
 * board.ts — the browser's client for the SwarmBoard.
 *
 * Reads use the route's REST snapshot (GET returns every task plus counts in
 * one request); writes use the JSON-RPC 2.0 tools the workers use
 * (create_task, claim_task, submit_task_work). Nothing here invents a route:
 * the contract is app/api/mcp/swarm-board/route.ts.
 *
 * `askBoard` talks to the board-agent at POST /api/board-agent/chat. When that
 * turn files a task, the task is loaded from the board snapshot and returned
 * with the reply. `createBoardTask` remains the direct create_task path.
 *
 * DOM-free; `fetchImpl` is injectable so the module unit-tests against the
 * real route handlers.
 */

import type { SwarmTask, TaskDifficulty, TaskStatus } from "../mcp-types";
import type { StatusTone } from "./runPhase";

export const BOARD_ENDPOINT = "/api/mcp/swarm-board";
export const BOARD_AGENT_CHAT_ENDPOINT = "/api/board-agent/chat";

/** What one turn of the board-agent chat produced. */
export interface BoardAgentTurn {
  reply: string;
  conversationId: string;
  /** The task the agent filed this turn, when it filed one. */
  task: SwarmTask | null;
}

/** Field caps enforced by lib/board/validation.ts. */
export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 8000;
export const TASK_SUMMARY_MAX = 8000;
export const TASK_BRANCH_MAX = 200;
export const TASK_PR_URL_MAX = 500;

/**
 * The rating a claim records when the worker has no arena rating of its own.
 * It is the board's own baseline (poll_tasks defaults workerElo to 1400).
 */
export const DEFAULT_WORKER_ELO = 1400;

export const TASK_DIFFICULTIES: readonly TaskDifficulty[] = ["trivial", "easy", "medium", "hard", "expert"];

export interface BoardCounts {
  tasks: number;
  open: number;
  claimed: number;
  in_review: number;
  completed: number;
}

export interface BoardSnapshot {
  tasks: SwarmTask[];
  counts: BoardCounts;
  /** False when the server cannot persist the board (new tasks would be lost). */
  writable: boolean;
}

export type BoardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable: boolean };

const STATUSES: ReadonlySet<string> = new Set(["open", "claimed", "in_review", "completed", "blocked"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Keep only rows that are usable as a task; the board file predates some fields. */
export function parseTask(raw: unknown): SwarmTask | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.title !== "string") return null;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  return {
    ...(raw as unknown as SwarmTask),
    description: typeof raw.description === "string" ? raw.description : "",
    constraints: Array.isArray(raw.constraints) ? raw.constraints.filter((c): c is string => typeof c === "string") : [],
    history: Array.isArray(raw.history) ? (raw.history as SwarmTask["history"]) : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export function parseBoardSnapshot(body: unknown): BoardSnapshot | null {
  if (!isRecord(body) || !Array.isArray(body.tasks)) return null;
  const tasks = body.tasks.map(parseTask).filter((task): task is SwarmTask => task !== null);
  const counts = isRecord(body.counts) ? body.counts : {};
  const health = isRecord(body.health) ? body.health : {};
  return {
    tasks,
    counts: {
      tasks: count(counts.tasks) || tasks.length,
      open: count(counts.open),
      claimed: count(counts.claimed),
      in_review: count(counts.in_review),
      completed: count(counts.completed),
    },
    writable: health.writable !== false,
  };
}

function failure(error: string, retryable = false): { ok: false; error: string; retryable: boolean } {
  return { ok: false, error, retryable };
}

function networkFailure(err: unknown) {
  return failure(err instanceof Error && err.message ? err.message : "Network error", true);
}

/** Pull the message out of a JSON-RPC error body (HTTP 200) or a 503 body. */
function rpcError(body: unknown, status: number): { ok: false; error: string; retryable: boolean } {
  const record = isRecord(body) ? body : {};
  const err = isRecord(record.error) ? record.error : {};
  const message = typeof err.message === "string" && err.message ? err.message : `HTTP ${status}`;
  return failure(message, record.retryable === true || status === 503);
}

/** Every task on the board, with counts. */
export async function fetchBoard(
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<BoardResult<BoardSnapshot>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(BOARD_ENDPOINT, { cache: "no-store", signal: options.signal });
  } catch (err) {
    return networkFailure(err);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) return rpcError(body, res.status);
  const snapshot = parseBoardSnapshot(body);
  return snapshot ? { ok: true, value: snapshot } : failure("The board returned an unreadable response.", true);
}

let rpcId = 0;

/**
 * Call one board tool over JSON-RPC 2.0 and return the task it reports.
 * Tool results arrive as MCP text content holding a JSON document.
 */
export async function callBoardTool(
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardResult<SwarmTask>> {
  let res: Response;
  try {
    res = await fetchImpl(BOARD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (err) {
    return networkFailure(err);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(body) || body.error !== undefined) return rpcError(body, res.status);
  const result = isRecord(body.result) ? body.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = isRecord(content[0]) && typeof content[0].text === "string" ? content[0].text : "";
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const task = isRecord(payload) ? parseTask(payload.task) : null;
  return task ? { ok: true, value: task } : failure("The board did not return the task.");
}

export interface NewTaskInput {
  title: string;
  description: string;
  difficulty: TaskDifficulty;
  constraints?: string[];
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Turn what the user typed into a task. The first line is the title; the
 * whole message is the description, so nothing they wrote is dropped.
 */
export function taskFromMessage(message: string, difficulty: TaskDifficulty = "medium"): NewTaskInput | null {
  const text = message.trim();
  if (!text) return null;
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? text;
  return {
    title: clip(firstLine, TASK_TITLE_MAX),
    description: clip(text, TASK_DESCRIPTION_MAX),
    difficulty,
  };
}

export function createBoardTask(input: NewTaskInput, fetchImpl: typeof fetch = fetch): Promise<BoardResult<SwarmTask>> {
  return callBoardTool(
    "create_task",
    {
      title: input.title,
      description: input.description,
      difficulty: input.difficulty,
      ...(input.constraints?.length ? { constraints: input.constraints } : {}),
    },
    fetchImpl,
  );
}

/**
 * Talk to the board-agent. An empty message never leaves the browser. A turn
 * that files a task returns that task so the board can show it immediately.
 */
export async function askBoard(
  message: string,
  options: { conversationId?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<BoardResult<BoardAgentTurn>> {
  const text = message.trim();
  if (!text) return failure("Describe the task first.");
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(BOARD_AGENT_CHAT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: text,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    return networkFailure(err);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" && body.error
      ? body.error
      : `HTTP ${response.status}`;
    return failure(error, response.status === 409 || response.status === 503);
  }
  const record = isRecord(body) ? body : {};
  const reply = typeof record.reply === "string" ? record.reply : "";
  const conversationId = typeof record.conversationId === "string" ? record.conversationId : "";
  const taskIds = Array.isArray(record.taskIds)
    ? record.taskIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (taskIds.length === 0) return { ok: true, value: { reply, conversationId, task: null } };
  const board = await fetchBoard({ fetchImpl, signal: options.signal });
  if (!board.ok) return board;
  const task = taskIds.map((id) => board.value.tasks.find((row) => row.id === id)).find((row) => row !== undefined) ?? null;
  return { ok: true, value: { reply, conversationId, task } };
}

export function claimBoardTask(
  input: { taskId: string; agentName: string; workerElo?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<BoardResult<SwarmTask>> {
  return callBoardTool(
    "claim_task",
    { taskId: input.taskId, agentName: input.agentName, workerElo: input.workerElo ?? DEFAULT_WORKER_ELO },
    fetchImpl,
  );
}

export interface SubmitTaskInput {
  taskId: string;
  agentName: string;
  gitBranch: string;
  summary: string;
  prUrl?: string;
}

export function submitBoardTask(input: SubmitTaskInput, fetchImpl: typeof fetch = fetch): Promise<BoardResult<SwarmTask>> {
  const prUrl = input.prUrl?.trim();
  return callBoardTool(
    "submit_task_work",
    {
      taskId: input.taskId,
      agentName: input.agentName,
      gitBranch: input.gitBranch.trim(),
      summary: clip(input.summary.trim(), TASK_SUMMARY_MAX),
      ...(prUrl ? { prUrl } : {}),
    },
    fetchImpl,
  );
}

// ---- Presentation helpers (pure) ----

export interface TaskStatusMeta {
  label: string;
  tone: StatusTone;
}

export const TASK_STATUS_META: Record<TaskStatus, TaskStatusMeta> = {
  open: { label: "Open", tone: "muted" },
  claimed: { label: "In progress", tone: "accent" },
  in_review: { label: "In review", tone: "warn" },
  completed: { label: "Completed", tone: "ok" },
  blocked: { label: "Blocked", tone: "err" },
};

/** The order a reader scans the board in: what can start, what is moving, what is done. */
export const BOARD_GROUP_ORDER: readonly TaskStatus[] = ["open", "claimed", "in_review", "blocked", "completed"];

/** Start of the day the canonical repo moved; older work belongs to the frozen archive. */
export const BOARD_ACTIVE_SINCE = Date.UTC(2026, 10, 20);

export interface BoardTaskSplit {
  active: SwarmTask[];
  hidden: SwarmTask[];
}

/**
 * Split board tasks into current work and frozen monolith-era leftovers.
 *
 * `createdAt` and `updatedAt` are the only dated fields every task carries —
 * `parseTask` normalizes both to numbers (0 for rows that predate them) — so
 * the latest of the two is the reliable signal. Display only: the input array
 * and its tasks are never changed.
 */
export function partitionBoardTasks(
  tasks: readonly SwarmTask[],
  since: number = BOARD_ACTIVE_SINCE,
): BoardTaskSplit {
  const active: SwarmTask[] = [];
  const hidden: SwarmTask[] = [];
  for (const task of tasks) {
    const latest = Math.max(task.createdAt ?? 0, task.updatedAt ?? 0);
    if (Number.isFinite(latest) && latest >= since) active.push(task);
    else hidden.push(task);
  }
  return { active, hidden };
}

export interface BoardGroup {
  status: TaskStatus;
  label: string;
  tasks: SwarmTask[];
  /**
   * Task ids that stand for more than one same-titled task, mapped to how
   * many tasks they collapse. Only ids with a count above 1 are present.
   */
  duplicateCounts: Record<string, number>;
}

/**
 * The title as a reader sees it: leading bracket tags ([fix], [p2],
 * [Router]…) are internal labels, not part of what the task is, so they are
 * dropped. A title that is only tags keeps its original text.
 */
export function displayTaskTitle(title: string): string {
  const stripped = title.replace(/^(?:\s*\[[^\]\n]+\])+\s*/, "").trim();
  return stripped || title.trim() || title;
}

/** The key two titles share when they name the same task: display form, folded case, one space. */
export function normalizeTaskTitle(title: string): string {
  const folded = displayTaskTitle(title).toLowerCase().replace(/\s+/g, " ").trim();
  return folded || title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * How far along a status is, for picking which copy of a duplicated title
 * the board shows: work that was submitted or finished outranks work that
 * merely started, and a stalled task outranks one nobody picked up.
 */
const STATUS_PROGRESS: Record<TaskStatus, number> = {
  open: 0,
  claimed: 1,
  blocked: 2,
  in_review: 3,
  completed: 4,
};

/**
 * Group tasks by status (empty groups dropped), newest activity first inside
 * each. Tasks that share a normalized title collapse to one row — the copy
 * furthest along (then the most recently active) — so the same task filed
 * twice reads once. Display only: the task list itself is untouched, and the
 * collapsed count is reported per group in `duplicateCounts`.
 */
export function groupBoardTasks(tasks: readonly SwarmTask[]): BoardGroup[] {
  const byTitle = new Map<string, SwarmTask[]>();
  for (const task of tasks) {
    const key = normalizeTaskTitle(task.title);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(task);
    else byTitle.set(key, [task]);
  }
  const representatives: SwarmTask[] = [];
  const collapsed: Record<string, number> = {};
  for (const bucket of byTitle.values()) {
    bucket.sort(
      (a, b) =>
        STATUS_PROGRESS[b.status] - STATUS_PROGRESS[a.status] ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
    const representative = bucket[0];
    representatives.push(representative);
    if (bucket.length > 1) collapsed[representative.id] = bucket.length;
  }
  const groups: BoardGroup[] = [];
  for (const status of BOARD_GROUP_ORDER) {
    const members = representatives
      .filter((task) => task.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (members.length === 0) continue;
    const duplicateCounts: Record<string, number> = {};
    for (const task of members) {
      const count = collapsed[task.id];
      if (count !== undefined) duplicateCounts[task.id] = count;
    }
    groups.push({ status, label: TASK_STATUS_META[status].label, tasks: members, duplicateCounts });
  }
  return groups;
}

/** "PR #128" for a GitHub-style pull URL, otherwise "Pull request". */
export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? `PR #${match[1]}` : "Pull request";
}

/** Only http(s) links are rendered as links; anything else is shown as text. */
export function isSafeHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\/[^\s]+$/i.test(url);
}

/** The name this user's VM agent claims tasks under. */
export function agentNameForUser(user: { id?: string; email?: string | null } | null | undefined): string {
  const who = user?.email?.trim() || user?.id?.trim() || "local";
  return clip(`${who} (VM)`, 200);
}

/**
 * The prompt a VM run gets for a board task. It asks for a reply the board
 * can use: a summary, plus the branch and PR when the work is in git.
 */
export function buildTaskPrompt(task: Pick<SwarmTask, "id" | "title" | "description" | "constraints">): string {
  const lines = [`Work on this SwarmBoard task (${task.id}).`, "", `Task: ${task.title}`];
  const description = task.description.trim();
  if (description && description !== task.title.trim()) lines.push("", description);
  if (task.constraints.length > 0) {
    lines.push("", "Constraints:", ...task.constraints.map((constraint) => `- ${constraint}`));
  }
  lines.push(
    "",
    "When you are done, reply with a short summary of what you changed and how you verified it.",
    'If the work is on a git branch, end with a line "Branch: <name>". If you opened a pull request, add "PR: <url>".',
  );
  return lines.join("\n");
}

/** Read the "Branch:" / "PR:" lines buildTaskPrompt asks the agent to end with. */
export function extractBranchAndPr(text: string | undefined): { branch?: string; prUrl?: string } {
  if (!text) return {};
  const branch = /^\s*(?:git\s+)?branch\s*:\s*`?([^\s`]+)`?\s*$/im.exec(text)?.[1];
  const prUrl = /^\s*(?:pr|pull request)\s*:\s*<?(https?:\/\/[^\s>]+)>?\s*$/im.exec(text)?.[1];
  return {
    ...(branch && branch.length <= TASK_BRANCH_MAX ? { branch } : {}),
    ...(prUrl && prUrl.length <= TASK_PR_URL_MAX ? { prUrl } : {}),
  };
}

// ---- Task ↔ run links ----
//
// A run started from a task is remembered in this browser so the board row
// and the conversation can point at each other. The board file has no field
// for a run id, and this task must not change the backend.

export interface TaskRunLink {
  taskId: string;
  title: string;
  runId: string;
  /** The agentName the task was claimed under (needed to submit its work). */
  agentName: string;
  startedAt: number;
}

export type TaskRunLinks = Record<string, TaskRunLink>;

const MAX_LINKS = 200;

/** Add or replace a task's link, dropping the oldest links past the cap. */
export function linkTaskRun(links: TaskRunLinks, link: TaskRunLink): TaskRunLinks {
  const next: TaskRunLinks = { ...links, [link.taskId]: link };
  const entries = Object.values(next);
  if (entries.length <= MAX_LINKS) return next;
  entries.sort((a, b) => b.startedAt - a.startedAt);
  return Object.fromEntries(entries.slice(0, MAX_LINKS).map((entry) => [entry.taskId, entry]));
}

export function taskLinkForRun(links: TaskRunLinks, runId: string | undefined): TaskRunLink | undefined {
  if (!runId) return undefined;
  return Object.values(links).find((link) => link.runId === runId);
}
