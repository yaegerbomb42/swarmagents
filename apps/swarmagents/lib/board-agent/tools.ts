import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { handleCreateTask, isClaimExpired, viewBoardTask } from "../board/handlers";
import { BoardUnavailableError, loadStore, withLockedStore } from "../board/store";
import { validatePollTasks } from "../board/validation";
import { classifyCommand } from "../harness/risk";
import { makeRedactor } from "../harness/redact";
import type {
  SwarmTask,
  VmExecResult,
  VmListWorkspaceResult,
  VmReadFileResult,
  VmReadOutputResult,
  VmScreenshotResult,
  VmWorkspaceEntry,
  VmWriteFileResult,
} from "../mcp-types";
import { getRuntimeManager, type RunStatus, type RuntimeManager } from "../runtime/manager";
import { getRun, getRunSummary } from "../runtime/run-store";
import type { SequencedEvent } from "../telemetry/bus";
import { DESKTOP_DISPLAY } from "../vm";
import {
  SHELL_MAX_ARGS,
  SHELL_MAX_ARG_LEN,
  SHELL_MAX_CMD_LEN,
  shellCommandText,
} from "../vm/argv";
import {
  looksBinary,
  MAX_FILE_READ_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  parentPath,
  resolveWorkspacePath,
  VmFileError,
  VmPathError,
  WORKSPACE_ROOT,
} from "../vm/files";
import { getVmManager, vmManager, type VmManager } from "../vm/manager";
import type { BoardAgentToolResult } from "./types";
import {
  isVmMcpTool,
  VM_MCP_TOOL_DEFINITIONS,
  vmExecInputSchema,
  vmListWorkspaceInputSchema,
  vmReadFileInputSchema,
  vmReadOutputInputSchema,
  vmScreenshotInputSchema,
  vmWriteFileInputSchema,
} from "./vm-schemas";

export {
  isVmMcpTool,
  VM_MCP_TOOL_DEFINITIONS,
  vmExecInputSchema,
  vmListWorkspaceInputSchema,
  vmReadFileInputSchema,
  vmReadOutputInputSchema,
  vmScreenshotInputSchema,
  vmWriteFileInputSchema,
};

type CreatedTask = { taskId: string; title: string };
type TaskListItem = Pick<SwarmTask, "id" | "title" | "status" | "claimedBy" | "prUrl">;
const BOARD_UNAVAILABLE = { ok: false, summary: "Board storage is temporarily unavailable. Try again shortly." };
const TASK_LIMIT = 20;
const DIGEST_SECTION_LIMIT = 5;
const MAX_USER_ID_LEN = 128;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_PREFIX = "/tmp/swarm-desktop-frame-";

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

// ---------------------------------------------------------------------------
// Per-user VM MCP tools
// ---------------------------------------------------------------------------

export interface VmToolDeps {
  runtime?: RuntimeManager;
  vm?: VmManager;
}

function validateUserId(userId: string): string | null {
  if (typeof userId !== "string") return null;
  const trimmed = userId.trim();
  if (!trimmed || trimmed.length > MAX_USER_ID_LEN) return null;
  return trimmed;
}

function resolveRuntime(deps?: VmToolDeps): RuntimeManager {
  return deps?.runtime ?? getRuntimeManager();
}

function resolveVm(deps?: VmToolDeps): VmManager {
  if (deps?.vm) return deps.vm;
  if (deps?.runtime) return deps.runtime.vmManager;
  const currentVm = getVmManager();
  if (currentVm !== vmManager) return currentVm;
  return getRuntimeManager().vmManager;
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((issue) => {
    const field = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${field}${issue.message}`;
  }).join("; ");
}

function normalizeExecCommand(
  cmd: string | string[],
): { argv: string[]; source: string; shellLine: boolean } | { error: string } {
  if (typeof cmd === "string") {
    const trimmed = cmd.trim();
    if (!trimmed) return { error: "cmd is required." };
    return { argv: ["bash", "-lc", trimmed], source: trimmed, shellLine: true };
  }
  const argv: string[] = [];
  for (const item of cmd) {
    if (item.length === 0) return { error: "cmd entries must be non-empty strings." };
    argv.push(item);
  }
  return { argv, source: shellCommandText(argv), shellLine: false };
}

function isTerminalEventType(type: string): boolean {
  return type === "run.finished" || type === "run.error" || type === "run.cancelled";
}

function clampOutputTail(text: string, maxChars = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function readEventNumber(event: SequencedEvent, key: string): number | undefined {
  const top = (event as unknown as Record<string, unknown>)[key];
  if (typeof top === "number" && Number.isFinite(top)) return top;
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    const nested = (event.data as Record<string, unknown>)[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

function readEventString(event: SequencedEvent, key: string): string | undefined {
  const top = (event as unknown as Record<string, unknown>)[key];
  if (typeof top === "string") return top;
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    const nested = (event.data as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function collectRunEvents(runtime: RuntimeManager, runId: string, fromSeq: number): SequencedEvent[] {
  const bySeq = new Map<number, SequencedEvent>();
  const persisted = getRun(runId);
  if (persisted) {
    for (const event of persisted.events) {
      if (event.seq > fromSeq) bySeq.set(event.seq, event);
    }
  }
  for (const event of runtime.telemetryBus.readBufferedEvents(runId, fromSeq)) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

async function waitForRunSettlement(
  runtime: RuntimeManager,
  userId: string,
  runId: string,
  fromSeq: number,
  waitMs: number,
): Promise<void> {
  if (waitMs <= 0) return;

  const isSettled = () => {
    const live = runtime.list(userId).find((item) => item.runId === runId);
    if (live && live.status !== "running" && live.status !== "queued") return true;
    const buffered = runtime.telemetryBus.readBufferedEvents(runId, fromSeq);
    if (buffered.some((event) => isTerminalEventType(event.type))) return true;
    const saved = getRunSummary(runId);
    if (saved && saved.userId === userId && saved.status !== "running" && saved.status !== "queued") return true;
    return false;
  };

  if (isSettled()) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    return;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      // Give finalizeShell a microtask to update runtime.list(userId) right after run.finished.
      queueMicrotask(resolve);
    };

    timer = setTimeout(finish, waitMs);
    timer.unref?.();

    unsubscribe = runtime.telemetryBus.subscribe(runId, fromSeq, (event) => {
      if (isTerminalEventType(event.type)) {
        finish();
      }
    });

    if (isSettled()) {
      finish();
    }
  });
}

function mapVmFileOrPathError(
  err: unknown,
  path: string,
): BoardAgentToolResult<never> {
  if (err instanceof VmPathError) {
    return {
      ok: false,
      error: err.code,
      summary: `${err.message} (${path})`,
    };
  }
  if (err instanceof VmFileError) {
    return {
      ok: false,
      error: err.code,
      summary: `${err.message} (${path})`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: "vm_error",
    summary: message || "VM operation failed.",
  };
}

export async function vmExec(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmExecResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmExecInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_exec arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  const normalized = normalizeExecCommand(parsed.data.cmd);
  if ("error" in normalized) {
    return { ok: false, error: "invalid_input", summary: normalized.error };
  }
  const { argv, source, shellLine } = normalized;

  if (source.includes("\0")) {
    return { ok: false, error: "invalid_input", summary: "cmd contains NUL bytes." };
  }
  if (argv.length > SHELL_MAX_ARGS) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `cmd has too many arguments (max ${SHELL_MAX_ARGS}).`,
    };
  }
  if (!shellLine) {
    for (const arg of argv) {
      if (Buffer.byteLength(arg, "utf8") > SHELL_MAX_ARG_LEN) {
        return {
          ok: false,
          error: "invalid_input",
          summary: `an argument is too long (max ${SHELL_MAX_ARG_LEN} bytes).`,
        };
      }
    }
  }
  if (source.length > SHELL_MAX_CMD_LEN) {
    return { ok: false, error: "invalid_input", summary: "cmd is too long." };
  }

  const risk = classifyCommand(source);
  if (risk.level === "deny" || risk.level === "ask") {
    return {
      ok: false,
      error: "command_blocked",
      summary:
        risk.level === "deny"
          ? risk.reason
          : `${risk.reason} — blocked from direct VM exec.`,
    };
  }

  const runtime = resolveRuntime(deps);
  const redact = makeRedactor({ ...process.env } as Record<string, string>);
  const redactedCommand = redact(source);
  const { runId } = runtime.execShell(owner, argv, source);

  const waitMs = parsed.data.waitMs ?? 0;
  if (waitMs > 0) {
    const read = await vmReadOutput(owner, { runId, fromSeq: 0, waitMs }, { runtime });
    if (read.ok && read.data) {
      const status =
        read.data.status === "finished" || read.data.status === "error" || read.data.status === "cancelled"
          ? read.data.status
          : "running";
      return {
        ok: true,
        summary: read.summary,
        data: {
          runId,
          command: redactedCommand,
          status,
          ...(read.data.exitCode !== undefined ? { exitCode: read.data.exitCode } : {}),
          stdout: read.data.stdout,
          stderr: read.data.stderr,
          output: read.data.output,
          ...(read.data.error !== undefined ? { error: read.data.error } : {}),
          lastSeq: read.data.lastSeq,
          truncated: read.data.truncated,
        },
      };
    }
  }

  return {
    ok: true,
    summary: `Started VM command as ${runId}: ${redactedCommand}`,
    data: {
      runId,
      command: redactedCommand,
      status: "running",
    },
  };
}

export async function vmReadOutput(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmReadOutputResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmReadOutputInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_read_output arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  const { runId } = parsed.data;
  const fromSeq = parsed.data.fromSeq ?? 0;
  const waitMs = parsed.data.waitMs ?? 0;
  const runtime = resolveRuntime(deps);

  if (!runtime.ownsRun(owner, runId)) {
    return {
      ok: false,
      error: "scope_denied",
      summary: `Run "${runId}" is outside your account scope or not found.`,
    };
  }

  if (waitMs > 0) {
    await waitForRunSettlement(runtime, owner, runId, fromSeq, waitMs);
  }

  const events = collectRunEvents(runtime, runId, fromSeq);
  const live = runtime.list(owner).find((item) => item.runId === runId);
  const saved = getRun(runId);
  const savedSummary = saved?.summary.userId === owner ? saved.summary : undefined;
  const redact = makeRedactor({ ...process.env } as Record<string, string>);

  let stdoutRaw = "";
  let stderrRaw = "";
  let combinedRaw = "";
  let status: string = live?.status ?? savedSummary?.status ?? "running";
  let exitCode: number | undefined = live?.exitCode ?? savedSummary?.exitCode;
  let errorMsg: string | undefined = live?.error ?? savedSummary?.error;
  let truncated = false;
  let lastSeq = fromSeq;

  for (const event of events) {
    if (event.seq > lastSeq) lastSeq = event.seq;
    if (event.type === "shell.output" && event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
      const data = event.data as { stream?: unknown; text?: unknown };
      const text = typeof data.text === "string" ? redact(data.text) : "";
      if (!text) continue;
      combinedRaw += text;
      if (data.stream === "stderr") {
        stderrRaw += text;
      } else {
        stdoutRaw += text;
      }
      continue;
    }
    if (event.type === "run.finished") {
      status = "finished";
      const code = readEventNumber(event, "exitCode");
      if (code !== undefined) exitCode = code;
      if ((event as unknown as Record<string, unknown>).truncated === true) truncated = true;
      continue;
    }
    if (event.type === "run.error") {
      status = "error";
      const msg = readEventString(event, "message");
      if (msg) errorMsg = redact(msg);
      const code = readEventNumber(event, "exitCode");
      if (code !== undefined) exitCode = code;
      continue;
    }
    if (event.type === "run.cancelled") {
      status = "cancelled";
      continue;
    }
    if (event.type === "assistant.text" && event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
      const text = (event.data as { text?: unknown }).text;
      if (typeof text === "string" && text) {
        const clean = redact(text);
        stdoutRaw += clean;
        combinedRaw += clean;
      }
    }
  }

  if (!stdoutRaw && !stderrRaw && savedSummary?.finalText && fromSeq === 0) {
    const clean = redact(savedSummary.finalText);
    stdoutRaw = clean;
    combinedRaw = clean;
  }

  const outClamp = clampOutputTail(combinedRaw);
  const stdoutClamp = clampOutputTail(stdoutRaw);
  const stderrClamp = clampOutputTail(stderrRaw);
  truncated = truncated || outClamp.truncated || stdoutClamp.truncated || stderrClamp.truncated;

  const summaryParts = [
    `Run ${runId} (${status}${exitCode !== undefined ? `, exitCode=${exitCode}` : ""})`,
  ];
  if (errorMsg) summaryParts.push(`Error: ${excerpt(errorMsg, 400)}`);
  if (outClamp.text) summaryParts.push(excerpt(outClamp.text, 2000));
  else summaryParts.push("(no new output)");

  return {
    ok: true,
    summary: summaryParts.join("\n"),
    data: {
      runId,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(errorMsg !== undefined ? { error: redact(errorMsg) } : {}),
      stdout: stdoutClamp.text,
      stderr: stderrClamp.text,
      output: outClamp.text,
      lastSeq,
      truncated,
    },
  };
}

export async function vmReadFile(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmReadFileResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmReadFileInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_read_file arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(parsed.data.path);
  } catch (err) {
    return mapVmFileOrPathError(err, parsed.data.path);
  }

  const vm = resolveVm(deps);
  try {
    const stat = await vm.stat(owner, resolved);
    if (stat.type === "directory") {
      return {
        ok: false,
        error: "is_a_directory",
        summary: `Path is a directory; use vm_list_workspace instead: ${resolved}`,
      };
    }
    const read = await vm.readFileBytes(owner, resolved, MAX_FILE_READ_BYTES);
    const binary = looksBinary(read.content);
    const result: VmReadFileResult = {
      path: resolved,
      size: read.size,
      binary,
      truncated: read.truncated,
      limit: MAX_FILE_READ_BYTES,
      ...(binary ? {} : { content: read.content.toString("utf8") }),
    };
    return {
      ok: true,
      summary: binary
        ? `Read binary file ${resolved} (${read.size} bytes).`
        : `Read ${resolved} (${read.size} bytes${read.truncated ? ", truncated" : ""}).`,
      data: result,
    };
  } catch (err) {
    return mapVmFileOrPathError(err, resolved);
  }
}

export async function vmWriteFile(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmWriteFileResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmWriteFileInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_write_file arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(parsed.data.path);
  } catch (err) {
    return mapVmFileOrPathError(err, parsed.data.path);
  }

  if (resolved === WORKSPACE_ROOT) {
    return {
      ok: false,
      error: "is_a_directory",
      summary: `Cannot overwrite workspace root directory ${WORKSPACE_ROOT}.`,
    };
  }

  const bytesWritten = Buffer.byteLength(parsed.data.content, "utf8");
  if (bytesWritten > MAX_UPLOAD_FILE_BYTES) {
    return {
      ok: false,
      error: "file_too_large",
      summary: `Content exceeds ${MAX_UPLOAD_FILE_BYTES} byte limit.`,
    };
  }

  const vm = resolveVm(deps);
  try {
    try {
      const existing = await vm.stat(owner, resolved);
      if (existing.type === "directory") {
        return {
          ok: false,
          error: "is_a_directory",
          summary: `Target path is an existing directory: ${resolved}`,
        };
      }
    } catch (err) {
      if (!(err instanceof VmFileError && err.code === "not_found")) {
        throw err;
      }
    }

    await vm.writeFile(owner, resolved, parsed.data.content);
    return {
      ok: true,
      summary: `Wrote ${bytesWritten} bytes to ${resolved}.`,
      data: { path: resolved, bytesWritten },
    };
  } catch (err) {
    return mapVmFileOrPathError(err, resolved);
  }
}

export async function vmListWorkspace(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmListWorkspaceResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmListWorkspaceInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_list_workspace arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(parsed.data.path ?? WORKSPACE_ROOT);
  } catch (err) {
    return mapVmFileOrPathError(err, parsed.data.path ?? WORKSPACE_ROOT);
  }

  const vm = resolveVm(deps);
  try {
    const stat = await vm.stat(owner, resolved);
    if (stat.type !== "directory") {
      return {
        ok: false,
        error: "not_a_directory",
        summary: `Path is not a directory: ${resolved}`,
      };
    }

    const rawEntries = await vm.listDir(owner, resolved);
    const entries: VmWorkspaceEntry[] = rawEntries.map((entry) => ({
      name: entry.name,
      path: `${resolved === WORKSPACE_ROOT ? WORKSPACE_ROOT : resolved}/${entry.name}`,
      type: entry.type,
      size: entry.size,
      ...(entry.modifiedAt !== undefined ? { modifiedAt: entry.modifiedAt } : {}),
    }));
    const lines = entries.length
      ? entries.map((e) => `${e.type === "directory" ? "[dir]" : "[file]"} ${e.name} (${e.size} bytes)`).join("\n")
      : "(empty directory)";
    return {
      ok: true,
      summary: `Listing ${resolved} (${entries.length} entries):\n${lines}`,
      data: {
        path: resolved,
        root: WORKSPACE_ROOT,
        parent: parentPath(resolved),
        entries,
      },
    };
  } catch (err) {
    return mapVmFileOrPathError(err, resolved);
  }
}

export async function vmScreenshot(
  userId: string,
  rawArgs: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<VmScreenshotResult>> {
  const owner = validateUserId(userId);
  if (!owner) {
    return {
      ok: false,
      error: "unauthorized",
      summary: "Authenticated user scope (x-swarm-user) is required.",
    };
  }

  const parsed = vmScreenshotInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_input",
      summary: `Invalid vm_screenshot arguments: ${formatZodIssues(parsed.error)}`,
    };
  }

  const vm = resolveVm(deps);
  const screenshotPath = `${SCREENSHOT_PREFIX}${randomUUID()}.png`;
  try {
    const state = await vm.status(owner);
    if (state.status !== "running") {
      return {
        ok: false,
        error: "vm_not_running",
        summary: "VM is not running for your account; start a run or shell command first.",
      };
    }

    const exec = await vm.exec(
      owner,
      ["scrot", "-o", screenshotPath],
      { env: { DISPLAY: DESKTOP_DISPLAY } },
    );
    if (exec.exitCode !== 0) {
      return {
        ok: false,
        error: "capture_failed",
        summary: "Desktop screenshot capture failed.",
      };
    }

    let file: { content: Buffer; size: number; truncated: boolean };
    try {
      file = await vm.readFileBytes(owner, screenshotPath, MAX_SCREENSHOT_BYTES);
    } finally {
      await vm.exec(owner, ["rm", "-f", "--", screenshotPath]).catch(() => undefined);
    }

    if (file.content.byteLength === 0) {
      return {
        ok: false,
        error: "empty_capture",
        summary: "Desktop screenshot capture was empty.",
      };
    }

    return {
      ok: true,
      summary: `Captured VM desktop screenshot (${file.content.byteLength} bytes, image/png).`,
      data: {
        mimeType: "image/png",
        bytes: file.content.byteLength,
        dataBase64: file.content.toString("base64"),
      },
    };
  } catch (err) {
    return mapVmFileOrPathError(err, screenshotPath);
  }
}

export async function callVmMcpTool(
  userId: string,
  name: string,
  args: unknown,
  deps?: VmToolDeps,
): Promise<BoardAgentToolResult<unknown>> {
  switch (name) {
    case "vm_exec":
      return vmExec(userId, args, deps);
    case "vm_read_output":
      return vmReadOutput(userId, args, deps);
    case "vm_read_file":
      return vmReadFile(userId, args, deps);
    case "vm_write_file":
      return vmWriteFile(userId, args, deps);
    case "vm_list_workspace":
      return vmListWorkspace(userId, args, deps);
    case "vm_screenshot":
      return vmScreenshot(userId, args, deps);
    default:
      return {
        ok: false,
        error: "unknown_tool",
        summary: `Unknown VM MCP tool: ${name}`,
      };
  }
}
