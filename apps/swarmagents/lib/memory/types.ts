/**
 * Long-term memory types.
 *
 * A memory is a short, durable fact about one account: a preference, a note
 * about a codebase, a recurring task pattern. Facts live in the app's per-user
 * data directory (never inside the VM), so they survive a VM reset, a new
 * container, or a redeploy.
 */

export const MEMORY_FILE = "memory.json";
export const MEMORY_SCHEMA_VERSION = 1;
export const MAX_FACT_CHARS = 2000;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 64;
export const DEFAULT_SEARCH_K = 5;
export const INJECTION_TOKEN_BUDGET = 1000;
/** How many memories are injected at the start of a run. */
export const MAX_INJECTED_MEMORIES = 5;
/** Upper bound on how many memories a single search returns. */
export const MAX_SEARCH_K = 50;
/** How many memories one account may keep (the oldest are dropped). */
export const MAX_FACTS = 500;

export type MemoryTag = string;

export interface MemoryFact {
  id: string;
  fact: string;
  tags: string[];
  /** Embedding of the fact text, when an embedder was available. */
  embedding?: number[];
  /** Which embedder produced `embedding` (e.g. "openai:text-embedding-3-small"). */
  embeddingModel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFile {
  version: number;
  userId: string;
  facts: MemoryFact[];
}

export interface MemorySearchResult {
  id: string;
  fact: string;
  tags: string[];
  score: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryWriteInput {
  fact: unknown;
  tags?: unknown;
}

export interface MemorySearchOptions {
  k?: number;
  tag?: string;
}

/** The three agent-callable memory tools. */
export const MEMORY_WRITE_TOOL = "memory_write";
export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_FORGET_TOOL = "memory_forget";

/** The result of one memory tool call (the shape the agent sees). */
export interface MemoryToolResult {
  ok: boolean;
  /** Machine-readable error code (e.g. "invalid_input", "not_found"). */
  error?: string;
  /** Human-readable explanation, safe to show the agent. */
  message?: string;
  /** The stored fact (memory_write). */
  fact?: MemoryFact;
  /** The matching facts (memory_search). */
  memories?: MemorySearchResult[];
  /** How many facts were removed (memory_forget / clear). */
  forgotten?: number;
}

/**
 * The RPC directory inside the user's VM. It lives in the container's
 * ephemeral /tmp on purpose: the memory store itself is on the host, and a VM
 * reset must leave no trace of it behind.
 */
export const MEMORY_VM_DIR = "/tmp/swarm-memory";
/** Prefix of a request envelope written by the in-VM MCP server. */
export const MEMORY_VM_REQUEST_PREFIX = "req-";
/** Prefix of the answer the host writes back into the VM. */
export const MEMORY_VM_RESPONSE_PREFIX = "res-";

