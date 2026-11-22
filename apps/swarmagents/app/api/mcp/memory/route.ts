/**
 * The long-term memory MCP server (JSON-RPC 2.0 over HTTP).
 *
 * The endpoint exposes the account's memory store as three MCP tools:
 *
 *   - memory_write(fact, tags?)  — remember a durable fact
 *   - memory_search(query, k?)   — recall the facts relevant to a query
 *   - memory_forget(id)          — drop one stored fact
 *
 * It is the same tool set the in-VM agent gets through the harness' memory
 * MCP server, so an agent and a remote MCP client see the same API. The
 * account comes from the request header the middleware sets from the
 * verified session: one account never sees another account's memories.
 */

import { NextResponse, type NextRequest } from "next/server";
import { providerOwner } from "@/lib/providers/owner";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { MEMORY_TOOL_SCHEMAS } from "@/lib/memory/tools";
import {
  dispatchMcpRequest,
  isRpcId,
  NO_STORE,
  type RpcId,
} from "@/lib/memory/mcp-rpc";

export const dynamic = "force-dynamic";

function jsonRpcError(code: number, message: string, id: RpcId, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: id ?? null },
    { status, headers: NO_STORE },
  );
}

/** GET: describe the server (handy for a quick health check). */
export function GET(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json(
    {
      name: "swarm-memory",
      version: "1.0.0",
      protocol: "mcp-jsonrpc",
      tools: MEMORY_TOOL_SCHEMAS.map((tool) => tool.name),
    },
    { headers: NO_STORE },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return jsonRpcError(-32602, "Request body too large", null);
    }
    return jsonRpcError(-32700, "Parse error", null, 400);
  }

  if (!isRecord(body)) return jsonRpcError(-32600, "Invalid Request", null);
  const { method, params, id: rawId } = body as { method?: unknown; params?: unknown; id?: unknown; jsonrpc?: unknown };
  if (rawId !== undefined && !isRpcId(rawId)) {
    // Retain the established tools/call validation code without echoing the
    // invalid ID in either error envelope.
    return method === "tools/call"
      ? jsonRpcError(-32602, "Invalid params: id must be a string, number, or null", null)
      : jsonRpcError(-32600, "Invalid Request", null);
  }
  const id = isRpcId(rawId) ? (rawId as RpcId) : null;
  if (body.jsonrpc !== "2.0" || typeof method !== "string" || !method.trim()) {
    return jsonRpcError(-32600, "Invalid Request", id);
  }

  // JSON-RPC notifications have no response body. Explicit null is still a
  // request ID for clients that use it.
  if (rawId === undefined) {
    return new NextResponse(null, { status: 202, headers: NO_STORE });
  }

  return dispatchMcpRequest(method, params, id, owner);
}
