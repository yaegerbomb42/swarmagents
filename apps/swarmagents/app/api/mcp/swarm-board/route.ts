import { NextRequest, NextResponse } from "next/server";
import {
  BoardUnavailableError,
  loadStore,
  withLockedStore,
  getStorageHealth,
} from "@/lib/board/store";
import type { BoardStore } from "@/lib/board/types";
import {
  handleInitialize,
  handlePing,
  handleToolsList,
  handleCreateTask,
  handlePollTasks,
  handleClaimTask,
  handleSubmitTaskWork,
  handleSubmitProposal,
  handleJudgeProposal,
  handleListProposals,
  handleReviewAndMergeTask,
  handleRecordMatch,
  handleSyncArtifact,
  handleListArtifacts,
  viewBoardTask,
  computeAgentStats,
} from "@/lib/board/handlers";

import { JsonBodyError, readJsonBody } from "@/lib/http";
import { providerOwner } from "@/lib/providers/owner";
import { callVmMcpTool, isVmMcpTool } from "@/lib/board-agent/tools";
import type { VmScreenshotResult } from "@/lib/mcp-types";

export const dynamic = "force-dynamic";
type RpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Board state is live work in progress: every reply, success or error, is uncacheable. */
const NO_STORE = { "cache-control": "no-store" } as const;

/** JSON-RPC server error reserved for a board that is readable again after retry. */
const BOARD_UNAVAILABLE_CODE = -32001;
const RETRY_AFTER_SECONDS = "2";

function isBoardUnavailable(err: unknown): err is BoardUnavailableError {
  return (
    err instanceof BoardUnavailableError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "BOARD_UNAVAILABLE")
  );
}

function jsonRpcError(code: number, message: string, id: RpcId, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: id ?? null },
    { status, headers: NO_STORE },
  );
}

function jsonRpcResponse(payload: { result?: unknown }, id: RpcId) {
  return NextResponse.json({ jsonrpc: "2.0", ...payload, id }, { status: 200, headers: NO_STORE });
}

/**
 * A 503-style, explicitly retryable response. Returning an empty task list
 * (the old behavior) would tell workers the board is genuinely empty and let
 * them proceed as if work had vanished; the client must retry instead.
 */
function boardUnavailableResponse(id?: RpcId) {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: BOARD_UNAVAILABLE_CODE,
      message: "Board storage is temporarily unavailable. Retry shortly.",
      data: { retryable: true },
    },
    code: "BOARD_UNAVAILABLE",
    retryable: true,
    id: id ?? null,
  };
  return NextResponse.json(body, {
    status: 503,
    headers: { ...NO_STORE, "Retry-After": RETRY_AFTER_SECONDS },
  });
}

function loadOrUnavailable(id?: RpcId): { store: BoardStore } | { response: NextResponse } {
  try {
    return { store: loadStore() };
  } catch (err) {
    if (isBoardUnavailable(err)) return { response: boardUnavailableResponse(id) };
    throw err;
  }
}

type HandlerResult =
  | { result: { content: Array<{ type: "text"; text: string }> } }
  | { error: { code: number; message: string } };

async function runLockedTool(
  id: RpcId,
  work: () => Promise<HandlerResult>,
): Promise<NextResponse> {
  const res = await work();
  if ("error" in res) return jsonRpcError(res.error.code, res.error.message, id);
  return jsonRpcResponse({ result: res.result }, id);
}

function runReadTool(
  id: RpcId,
  work: (store: BoardStore) => HandlerResult,
): NextResponse {
  const loaded = loadOrUnavailable(id);
  if ("response" in loaded) return loaded.response;
  const res = work(loaded.store);
  if ("error" in res) return jsonRpcError(res.error.code, res.error.message, id);
  return jsonRpcResponse({ result: res.result }, id);
}

// GET: Returns current board status, active tasks, proposals, and messages
export async function GET(req: NextRequest) {
  const loaded = loadOrUnavailable();
  if ("response" in loaded) return loaded.response;
  const store = loaded.store;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const now = Date.now();
  const effectiveTasks = store.tasks.map((task) => viewBoardTask(task, now));
  // Use the same effective state for the rows and counts, including expiry.
  const tasks = effectiveTasks.filter((task) => !status || task.status === status)
    .map((task) => ({ ...task, history: Array.isArray(task.history) ? task.history : [] }));

  return NextResponse.json({
    name: "swarm-board",
    version: "2.0.0",
    protocol: "mcp-jsonrpc-and-rest",
    health: getStorageHealth(),
    counts: {
      tasks: store.tasks.length,
      open: effectiveTasks.filter((t) => t.status === "open").length,
      claimed: effectiveTasks.filter((t) => t.status === "claimed").length,
      in_review: effectiveTasks.filter((t) => t.status === "in_review").length,
      completed: effectiveTasks.filter((t) => t.status === "completed").length,
      pending_proposals: store.proposals.filter((p) => p.status === "pending").length,
      artifacts: store.artifacts?.length ?? 0,
    },
    artifacts: store.artifacts ?? [],
    agents: computeAgentStats(effectiveTasks),
    tasks,
    proposals: store.proposals.map((p) => ({
      ...p,
      decisions: Array.isArray(p.decisions) ? p.decisions : [],
    })),
    messages: store.messages.slice(-20),
  }, { headers: NO_STORE });
}

type LibraryToolHandler = () => Promise<NextResponse> | NextResponse;

function dispatchLibraryTool(
  id: RpcId,
  name: string,
  args: Record<string, unknown>,
): LibraryToolHandler | null {
  const handlers: Record<string, () => Promise<NextResponse> | NextResponse> = {
    create_task: () => runLockedTool(id, () => withLockedStore((store) => handleCreateTask(store, args))),
    poll_tasks: () => runReadTool(id, (store) => handlePollTasks(store, args)),
    claim_task: () => runLockedTool(id, () => withLockedStore((store) => handleClaimTask(store, args))),
    submit_task_work: () => runLockedTool(id, () => withLockedStore((store) => handleSubmitTaskWork(store, args))),
    submit_proposal: () => runLockedTool(id, () => withLockedStore((store) => handleSubmitProposal(store, args))),
    list_proposals: () => runReadTool(id, (store) => handleListProposals(store, args)),
    judge_proposal: () => runLockedTool(id, () => withLockedStore((store) => handleJudgeProposal(store, args))),
    review_and_merge_task: () => runLockedTool(id, () => withLockedStore((store) => handleReviewAndMergeTask(store, args))),
    record_match: () => runLockedTool(id, () => withLockedStore((store) => handleRecordMatch(store, args))),
    sync_artifact: () => runLockedTool(id, () => withLockedStore((store) => handleSyncArtifact(store, args))),
    list_artifacts: () => runReadTool(id, (store) => handleListArtifacts(store, args)),
  };
  return handlers[name] ?? null;
}

function buildVmPayload(res: { ok: boolean; data?: unknown; summary: string; error?: string }) {
  if (res.ok) {
    return {
      ok: true,
      summary: res.summary,
      ...(isRecord(res.data) ? res.data : res.data !== undefined ? { data: res.data } : {}),
    };
  }
  return { ok: false, error: res.error ?? "vm_error", summary: res.summary };
}

function appendScreenshotImage(
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
  name: string,
  res: { ok: boolean; data?: unknown },
): void {
  if (!res.ok || name !== "vm_screenshot" || !isRecord(res.data)) return;
  const shot = res.data as unknown as VmScreenshotResult;
  if (typeof shot.dataBase64 === "string" && shot.dataBase64.length > 0) {
    content.push({ type: "image", data: shot.dataBase64, mimeType: shot.mimeType });
  }
}

async function dispatchVmToolCall(
  id: RpcId,
  name: string,
  args: Record<string, unknown>,
  req: NextRequest,
): Promise<NextResponse> {
  const owner = providerOwner(req);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  const res = await callVmMcpTool(owner, name, args);
  if (!res.ok && res.error === "invalid_input") {
    return jsonRpcError(-32602, res.summary, id);
  }

  const payload = buildVmPayload(res);
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: JSON.stringify(payload) },
  ];
  appendScreenshotImage(content, name, res);
  return jsonRpcResponse({ result: { content, isError: !res.ok } }, id);
}

async function dispatchToolsCall(
  id: RpcId,
  params: unknown,
  req: NextRequest,
): Promise<NextResponse> {
  if (!isRecord(params) || typeof params.name !== "string" || !params.name.trim() ||
      (params.arguments !== undefined && !isRecord(params.arguments))) {
    return jsonRpcError(-32602, "Invalid params: expected a tool name and optional arguments object", id);
  }
  const { name, arguments: args = {} } = params;

  const handler = dispatchLibraryTool(id, name, args);
  if (handler) return await handler();

  if (isVmMcpTool(name)) return await dispatchVmToolCall(id, name, args, req);

  return jsonRpcError(-32601, `Unknown tool: ${name}`, id);
}

async function dispatchRequest(method: string, params: unknown, id: RpcId, req: NextRequest): Promise<NextResponse> {
  if (params !== undefined && !isRecord(params) && !Array.isArray(params)) {
    return jsonRpcError(-32602, "Invalid params", id);
  }

  if (method === "initialize") {
    return jsonRpcResponse(handleInitialize(id), id);
  }

  if (method === "ping") {
    return jsonRpcResponse(handlePing(id), id);
  }

  if (method === "tools/list") {
    return jsonRpcResponse(handleToolsList(id), id);
  }

  if (method === "tools/call") {
    return dispatchToolsCall(id, params, req);
  }

  return jsonRpcError(-32601, "Method not found", id);
}

function invalidIdError(method: string): NextResponse {
  if (method === "tools/call") {
    return jsonRpcError(-32602, "Invalid params: id must be a string, number, or null", null);
  }
  return jsonRpcError(-32600, "Invalid Request", null);
}

// POST: Single JSON-RPC 2.0 request (batch calls are not part of this endpoint).
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return jsonRpcError(-32602, "Request body too large", null);
    }
    return jsonRpcError(-32700, "Parse error", null, 400);
  }

  if (!isRecord(body)) return jsonRpcError(-32600, "Invalid Request", null);
  const { method, params, id: rawId } = body;
  const id = isRpcId(rawId) ? rawId : null;
  if (body.jsonrpc !== "2.0" || typeof method !== "string" || !method.trim()) {
    return jsonRpcError(-32600, "Invalid Request", id);
  }
  if (rawId !== undefined && !isRpcId(rawId)) {
    // Retain the established tools/call validation code without echoing
    // the invalid ID in either error envelope.
    return invalidIdError(method);
  }

  // JSON-RPC notifications (id === undefined): allowlist valid notification methods.
  // Mutating requests or methods requiring a reply without an id are rejected with -32600.
  if (rawId === undefined) {
    if (method.startsWith("notifications/") || method === "ping") {
      return new NextResponse(null, { status: 202, headers: NO_STORE });
    }
    return jsonRpcError(-32600, "Invalid Request: notifications must be notifications/* or ping", null);
  }

  let response: NextResponse;
  try {
    response = await dispatchRequest(method, params, id, req);
  } catch (err) {
    if (isBoardUnavailable(err)) response = boardUnavailableResponse(id);
    else {
      console.error("[swarm-board] JSON-RPC handler failed", err);
      response = jsonRpcError(-32603, "Internal error", id);
    }
  }
  return response;
}
