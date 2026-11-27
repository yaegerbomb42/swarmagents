/**
 * Round-trip terminal command support for the computer-use MCP server
 * (run-terminal.mjs).
 *
 * `run_in_terminal` types a command into a visible terminal, presses Return,
 * and waits for the screen to settle (two consecutive OCR reads identical)
 * before returning only the lines that appeared after the command was typed.
 * This module holds the pure pieces of that loop — the "what is new" diff and
 * the settle poll — so unit tests can exercise them with an injected reader
 * (no X server needed). The server wires them to the real window-text capture.
 */

/** Fallback: when no pre-command lines match, return this many newest lines. */
export const RUN_TERMINAL_FALLBACK_LINES = 40;
/** Default poll interval between screen reads (ms). */
export const RUN_TERMINAL_POLL_MS = 400;

/**
 * Normalize one OCR line for comparison: collapse runs of whitespace and trim.
 * OCR from the same static screen varies in stray spaces, so a stable equality
 * key must ignore them. Lowercasing keeps "ERROR" vs "error" reads equal.
 */
export function normalizeOcrLine(line) {
  return String(line ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Are two OCR line arrays equal (normalized comparison)? */
export function sameLines(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeOcrLine(a[i]) !== normalizeOcrLine(b[i])) return false;
  }
  return true;
}

/**
 * The lines that appeared after the command line: the newest OCR read minus
 * the longest prefix that matches the pre-command read (terminals append new
 * output below the old content). When nothing matches — the output scrolled
 * the old lines off the crop, or the screen was cleared — fall back to the
 * last `fallbackLines` (default 40) newest lines. Returns
 * `{ lines, matchedBefore }`; never throws.
 */
export function diffNewLines(current, before, { fallbackLines = RUN_TERMINAL_FALLBACK_LINES } = {}) {
  const cur = Array.isArray(current) ? current : [];
  const prev = Array.isArray(before) ? before : [];
  if (cur.length === 0) return { lines: [], matchedBefore: prev.length > 0 };
  if (prev.length === 0) return { lines: cur.slice(), matchedBefore: false };
  let n = 0;
  const max = Math.min(prev.length, cur.length);
  while (n < max && normalizeOcrLine(prev[n]) === normalizeOcrLine(cur[n])) n++;
  if (n > 0) return { lines: cur.slice(n), matchedBefore: true };
  const cap = Math.max(1, Math.floor(Number(fallbackLines) || RUN_TERMINAL_FALLBACK_LINES));
  return { lines: cur.length > cap ? cur.slice(-cap) : cur.slice(), matchedBefore: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `read` (an async () => { ok, lines } reader, e.g. captureWindowText)
 * every ~intervalMs until two consecutive reads are identical (screen settled)
 * or `timeoutMs` elapses. Failed reads are skipped (transient OCR/tool
 * errors do not reset settle progress). Resolves
 * `{ settled, lines, elapsedMs }`; never throws.
 */
export async function settleTerminal(read, { timeoutMs = 10_000, intervalMs = RUN_TERMINAL_POLL_MS } = {}) {
  const started = Date.now();
  let prev = null;
  let lastLines = [];
  while (true) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    const res = await read();
    if (res && res.ok === true && Array.isArray(res.lines)) {
      lastLines = res.lines;
      if (prev !== null && sameLines(prev, res.lines)) {
        return { settled: true, lines: lastLines, elapsedMs: Date.now() - started };
      }
      prev = res.lines;
    }
    if (Date.now() - started + intervalMs > timeoutMs) break;
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  return { settled: false, lines: lastLines, elapsedMs: Date.now() - started };
}
