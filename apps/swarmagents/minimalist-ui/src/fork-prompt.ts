/**
 * Fork Prompt (core-32): a share link's "Try this prompt" CTA lands on the
 * main workspace with ?prompt=<text>. The composer pre-fills once and the
 * parameter is stripped, so a refresh keeps the visitor's own edits instead
 * of re-injecting the forked prompt.
 */

/** Matches the guest suggestion cap (MAX_SUGGESTION_LEN in the live room). */
export const FORK_PROMPT_MAX_LEN = 8000;

export function forkPromptFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("prompt");
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, FORK_PROMPT_MAX_LEN);
  return trimmed ? trimmed : null;
}
