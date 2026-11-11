/**
 * terminalFilter — pure log-line helpers for the terminal drawer.
 *
 * Kept free of React so ANSI stripping, regex filtering, and the
 * autoscroll-lock decision can be unit-tested directly. No deps.
 */

/** Matches CSI escape sequences (`\x1b[31m`, `\x1b[0K`, …) + OSC hyperlinks. */
const ANSI_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI/VT100 escape codes so copied text is clean. */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(ANSI_PATTERN, '');
}

export type LineFilter =
  | { kind: 'text'; needle: string }
  | { kind: 'regex'; source: string };

export type FilterResult =
  | { ok: true; filter: LineFilter }
  | { ok: false; error: string };

/**
 * Parse the filter box value. `/pattern/flags` is regex; anything else is a
 * case-insensitive substring. Empty input matches everything.
 */
export function parseLineFilter(raw: string): FilterResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: true, filter: { kind: 'text', needle: '' } };
  if (input.startsWith('/') && input.length > 1) {
    const lastSlash = input.lastIndexOf('/');
    if (lastSlash > 0) {
      const source = input.slice(1, lastSlash);
      const flags = input.slice(lastSlash + 1);
      if (!/^[gimsuy]*$/.test(flags)) {
        return { ok: false, error: `Bad regex flags "${flags}" — use g, i, m, s, u, y` };
      }
      try {
        // eslint-disable-next-line no-new -- validation only
        new RegExp(source, flags.includes('i') ? flags : `${flags}i`);
        return { ok: true, filter: { kind: 'regex', source: `${source}::${flags}` } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Invalid regex' };
      }
    }
  }
  return { ok: true, filter: { kind: 'text', needle: input.toLowerCase() } };
}

/** Test one (already ANSI-stripped) line against a parsed filter. */
export function matchLine(filter: LineFilter, line: string): boolean {
  if (filter.kind === 'text') {
    if (!filter.needle) return true;
    return line.toLowerCase().includes(filter.needle);
  }
  const sep = filter.source.lastIndexOf('::');
  const source = sep >= 0 ? filter.source.slice(0, sep) : filter.source;
  const flags = sep >= 0 ? filter.source.slice(sep + 2) : 'i';
  try {
    return new RegExp(source, flags.includes('i') ? flags : `${flags}i`).test(line);
  } catch {
    return true;
  }
}

export type ScrollLockState = {
  /** True while the user has scrolled up (tailing paused). */
  locked: boolean;
  /** Lines that arrived while locked (cap surfaced to the UI). */
  pending: number;
};

const PENDING_CAP = 999;

/** Record arrivals while locked; clamps the badge counter. */
export function noteArrivals(state: ScrollLockState, count: number): ScrollLockState {
  if (!state.locked || count <= 0) return state;
  return { ...state, pending: Math.min(PENDING_CAP, state.pending + count) };
}
