/**
 * The memory block that is injected into a run.
 *
 * The block is part of the agent's system prompt (not the user prompt), so
 * the agent treats it as context it already knows rather than as an
 * instruction from the user. It carries the most relevant memories of the
 * account plus a one-line reminder of how to use the memory tools.
 */

/** How the agent is told to use the memory tools. */
export const MEMORY_TOOL_HINT =
  "You have a long-term memory for this account (the memory tools: memory_write, memory_search, memory_forget). " +
  "Use memory_write for durable facts — a preference, a note about a codebase, a recurring task pattern — " +
  "memory_search to look one up, and memory_forget to drop one. Secrets are redacted before they are stored.";

/**
 * Build the system-prompt block for one run. Returns an empty string when
 * the account has no memory to inject (the hint is then left out too, so a
 * first run is not told about tools that have nothing to show).
 */
export function buildMemoryPrompt(context: string): string {
  const body = context.trim();
  if (!body) return "";
  return `${body}\n\n${MEMORY_TOOL_HINT}`;
}
