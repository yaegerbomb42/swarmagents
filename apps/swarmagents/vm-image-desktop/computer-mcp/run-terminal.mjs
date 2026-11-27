/**
 * Round-trip terminal command support for the computer-use MCP server
 * (run-terminal.mjs).
 *
 * `run_in_terminal` types a command into a visible terminal, presses Return,
 * and waits for the screen to settle (identical reads with a prompt back, or a quiet period)
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

/** Quiet period required when the screen is stable but no shell prompt is back yet (ms). */
export const RUN_TERMINAL_QUIET_MS = 3000;

/**
 * Does the newest non-empty OCR line look like an idle shell prompt
 * (`user@host:~$`, `root@x:/#`, `%`, `>`)? A prompt is the strongest "command
 * finished" signal; without it a slow command (sleep, build, network) can
 * show two identical frames mid-run.
 */
export function looksLikePrompt(lines) {
  if (!Array.isArray(lines)) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] ?? "").trimEnd();
    if (!line.trim()) continue;
    return /[$#%>]$/.test(line);
  }
  return false;
}

/**
 * Poll `read` (an async () => { ok, lines } reader, e.g. captureWindowText)
 * every ~intervalMs until the screen has settled or `timeoutMs` elapses.
 * Settled means: two consecutive identical reads AND either the newest line
 * is a shell prompt, or the screen has stayed unchanged for `quietMs` (a
 * long-running command that is silent must not "settle" after 400ms).
 * When `before` (the pre-command read) is given, a read identical to it never
 * counts as settled (the command has not even echoed yet). Failed reads are
 * skipped. Resolves `{ settled, lines, elapsedMs }`; never throws.
 */
export async function settleTerminal(
  read,
  { timeoutMs = 10_000, intervalMs = RUN_TERMINAL_POLL_MS, quietMs = RUN_TERMINAL_QUIET_MS, before = null } = {},
) {
  const started = Date.now();
  let prev = null;
  let stableSince = 0;
  let lastLines = [];
  while (true) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    let res = null;
    try {
      res = await read();
    } catch {
      res = null;
    }
    if (res && res.ok === true && Array.isArray(res.lines)) {
      const now = Date.now();
      lastLines = res.lines;
      const unchangedFromBefore = Array.isArray(before) && sameLines(before, res.lines);
      if (prev !== null && sameLines(prev, res.lines) && !unchangedFromBefore) {
        if (!stableSince) stableSince = now;
        if (looksLikePrompt(res.lines) || now - stableSince >= quietMs) {
          return { settled: true, lines: lastLines, elapsedMs: now - started };
        }
      } else {
        stableSince = 0;
      }
      prev = res.lines;
    }
    if (Date.now() - started + intervalMs > timeoutMs) break;
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  return { settled: false, lines: lastLines, elapsedMs: Date.now() - started };
}
