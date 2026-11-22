/**
 * JSON-RPC 2.0 dispatch for the memory MCP endpoint.
 *
 * Kept separate from the Next.js route so the test hook (which swaps the tool
 * runner) lives in a plain module — Next.js route modules reject any export
 * beyond the route handlers and config keys.
 */

import { NextResponse } from "next/server";
import { MEMORY_TOOL_SCHEMAS, runMemoryTool } from "@/lib/memory/tools";

export const NO_STORE = { "cache-control": "no-store" } as const;

export type RpcId = string | number | null;

/** Tool runner override, injectable from tests (see setMemoryToolRunnerForTesting). */
let toolRunner: typeof runMemoryTool = runMemoryTool;

/** Test hook: swap the tool runner (e.g. to force a throw). */
export function setMemoryToolRunnerForTesting(runner?: typeof runMemoryTool): void {
  toolRunner = runner ?? runMemoryTool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcId(value: unknown): value is RpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function jsonRpcError(code: number, message: string, id: RpcId, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: id ?? null },
    { status, headers: NO_STORE },
  );
}

function jsonRpcResponse(payload: { result?: unknown }, id: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", ...payload, id }, { status: 200, headers: NO_STORE });
}

async function dispatchRequest(
  method: string,
  params: unknown,
  id: RpcId,
  owner: string,
): Promise<NextResponse> {
  if (params !== undefined && !isRecord(params)) {
    return jsonRpcError(-32602, "Invalid params", id);
  }

  if (method === "initialize") {
    return jsonRpcResponse(
      {
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "swarm-memory", version: "1.0.0" },
        },
      },
      id,
    );
  }

  if (method === "ping") {
    return jsonRpcResponse({ result: {} }, id);
  }

  if (method === "tools/list") {
    return jsonRpcResponse({ result: { tools: MEMORY_TOOL_SCHEMAS } }, id);
  }

  if (method === "tools/call") {
    if (!isRecord(params) || typeof params.name !== "string" || !params.name.trim() ||
        (params.arguments !== undefined && !isRecord(params.arguments))) {
      return jsonRpcError(-32602, "Invalid params: expected a tool name and optional arguments object", id);
    }
    const { name, arguments: args = {} } = params;
    let answer: Awaited<ReturnType<typeof runMemoryTool>>;
    try {
      answer = await toolRunner(owner, name, args);
    } catch (err) {
      console.error("[swarm-memory] tools/call failed", err);
      return jsonRpcError(-32603, "Internal error", id);
    }
    return jsonRpcResponse(
      {
        result: {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.ok !== true,
        },
      },
      id,
    );
  }

  return jsonRpcError(-32601, "Method not found", id);
}

/** Dispatch one validated JSON-RPC request and produce the response. */
export async function dispatchMcpRequest(
  method: string,
  params: unknown,
  id: RpcId,
  owner: string,
): Promise<NextResponse> {
  try {
    return await dispatchRequest(method, params, id, owner);
  } catch (err) {
    console.error("[swarm-memory] JSON-RPC handler failed", err);
    return jsonRpcError(-32603, "Internal error", id);
  }
}
