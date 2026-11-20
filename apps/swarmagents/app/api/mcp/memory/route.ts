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
import { MEMORY_TOOL_SCHEMAS, runMemoryTool } from "@/lib/memory/tools";

export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const NO_STORE = { "cache-control": "no-store" } as const;

function jsonRpcError(code: number, message: string, id: unknown, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", error: { code, message }, id: id ?? null }, { status });
}

function jsonRpcResponse(payload: { result?: unknown }, id: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", ...payload, id }, { status: 200, headers: NO_STORE });
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

export async function POST(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonRpcError(-32700, "Parse error", null, 400);
  }
  if (text.length > MAX_BODY_SIZE) {
    return jsonRpcError(-32602, "Request body too large", null);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonRpcError(-32700, "Parse error", null, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonRpcError(-32600, "Invalid Request", null);
  }

  const payload = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (payload.jsonrpc !== "2.0") {
    return jsonRpcError(-32600, "Invalid Request", payload.id ?? null);
  }

  const id = payload.id ?? null;
  const method = typeof payload.method === "string" ? payload.method : "";

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
    const params = (payload.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : "";
    const answer = await runMemoryTool(owner, name, params.arguments ?? {});
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
