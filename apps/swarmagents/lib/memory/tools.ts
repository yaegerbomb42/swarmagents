/**
 * The agent-facing memory tools.
 *
 * Three tools, one implementation, three callers:
 *   - the MCP endpoint (`/api/mcp/memory`) for remote MCP clients,
 *   - the VM bridge that serves the in-VM MCP server (the agent's tools),
 *   - the REST API the settings screen uses.
 *
 * Every call is scoped to one account: the caller passes the owner and the
 * tool can never reach another account's memories.
 */

import { forgetMemory, searchMemories, writeMemory } from "./store";
import {
  DEFAULT_SEARCH_K,
  MAX_FACT_CHARS,
  MAX_SEARCH_K,
  MAX_TAGS,
  MEMORY_FORGET_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_WRITE_TOOL,
  type MemoryFact,
  type MemorySearchResult,
  type MemoryToolResult,
} from "./types";
import type { DataDirOptions } from "../providers/store";

/** The MCP tool schemas, as advertised by `tools/list`. */
export const MEMORY_TOOL_SCHEMAS = [
  {
    name: MEMORY_WRITE_TOOL,
    description:
      "Remember a durable fact about this account (a preference, a codebase note, a recurring task pattern). " +
      "It is stored outside the VM and is injected into future runs. Secrets are redacted before saving.",
    inputSchema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact to remember, one or two short sentences.",
          maxLength: MAX_FACT_CHARS,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tags, e.g. \"preference\", \"codebase:<repoHash>\", \"task-pattern\". Max " +
            String(MAX_TAGS) +
            " tags.",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: MEMORY_SEARCH_TOOL,
    description:
      "Look up the account's long-term memories that are relevant to a query. Returns the best matches, " +
      "most relevant first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        k: {
          type: "number",
          description: `How many memories to return (default ${DEFAULT_SEARCH_K}, max ${MAX_SEARCH_K}).`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: MEMORY_FORGET_TOOL,
    description: "Forget one stored memory by id (use memory_search to find the id).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the memory to remove." },
      },
      required: ["id"],
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Public shape of a stored fact (no embedding vector — it is noise for a reader). */
export function publicFact(fact: MemoryFact): {
  id: string;
  fact: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
} {
  return {
    id: fact.id,
    fact: fact.fact,
    tags: fact.tags,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Run one memory tool for one account. Never throws: a bad call comes back
 * as `{ ok: false, error }` so the agent can correct itself.
 */
export async function runMemoryTool(
  userId: string,
  name: string,
  args: unknown,
  options: DataDirOptions = {},
): Promise<MemoryToolResult> {
  const input = isRecord(args) ? args : {};

  if (name === MEMORY_WRITE_TOOL) {
    const fact = asString(input.fact);
    if (!fact) {
      return { ok: false, error: "invalid_input", message: "fact must be a non-empty string." };
    }
    const tags = Array.isArray(input.tags) ? input.tags : undefined;
    try {
      const stored = await writeMemory(userId, { fact, tags }, options);
      return { ok: true, fact: stored };
    } catch (error) {
      return {
        ok: false,
        error: "write_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (name === MEMORY_SEARCH_TOOL) {
    const query = asString(input.query);
    if (!query) {
      return { ok: false, error: "invalid_input", message: "query must be a non-empty string." };
    }
    const rawK = typeof input.k === "number" && Number.isFinite(input.k) ? Math.floor(input.k) : DEFAULT_SEARCH_K;
    const k = Math.max(1, Math.min(rawK, MAX_SEARCH_K));
    const memories: MemorySearchResult[] = await searchMemories(userId, query, { k }, options);
    return { ok: true, memories };
  }

  if (name === MEMORY_FORGET_TOOL) {
    const id = asString(input.id);
    if (!id) {
      return { ok: false, error: "invalid_input", message: "id must be a non-empty string." };
    }
    const removed = forgetMemory(userId, id, options);
    if (!removed) {
      return { ok: false, error: "not_found", message: `No memory with id ${id}.` };
    }
    return { ok: true, forgotten: 1 };
  }

  return { ok: false, error: "unknown_tool", message: `Unknown tool: ${name}` };
}
