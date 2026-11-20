/**
 * Per-session command history for the interactive terminal.
 *
 * The terminal keeps at most the last TERMINAL_HISTORY_LIMIT commands in
 * sessionStorage (see useSessionPersisted). Up/Down browse that list and a
 * draft entry remembers whatever the user was typing before they started
 * browsing, so Down past the newest entry restores it.
 *
 * The reducer is framework-independent so it can be unit-tested without a
 * DOM; the component only owns the storage side effect.
 */

export const TERMINAL_HISTORY_LIMIT = 100;

export interface TerminalHistoryState {
  /** Oldest first, newest last, capped at TERMINAL_HISTORY_LIMIT. */
  entries: string[];
  /** Browsing cursor: -1 when not browsing, otherwise an entries index. */
  index: number;
  /** Input captured when browsing began; restored when browsing ends. */
  draft: string;
}

export const EMPTY_TERMINAL_HISTORY: TerminalHistoryState = {
  entries: [],
  index: -1,
  draft: "",
};

export type TerminalHistoryAction =
  | { type: "remember"; command: string }
  | { type: "up"; draft?: string }
  | { type: "down" }
  | { type: "reset" };

function asEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(-TERMINAL_HISTORY_LIMIT);
}

/** Coerce stored/persisted JSON into a valid state (old versions stored an array). */
export function sanitizeTerminalHistory(value: unknown): TerminalHistoryState {
  if (Array.isArray(value)) {
    return { entries: asEntries(value), index: -1, draft: "" };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = asEntries(record.entries);
    const rawIndex = typeof record.index === "number" ? record.index : -1;
    const index =
      Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < entries.length
        ? rawIndex
        : -1;
    const draft = typeof record.draft === "string" ? record.draft : "";
    return { entries, index, draft };
  }
  return EMPTY_TERMINAL_HISTORY;
}

/** The command currently shown for this state (browsed entry or the draft). */
export function terminalHistoryValue(state: TerminalHistoryState): string {
  if (state.index >= 0 && state.index < state.entries.length) {
    return state.entries[state.index];
  }
  return state.draft;
}

export function terminalHistoryReducer(
  state: TerminalHistoryState,
  action: TerminalHistoryAction,
): TerminalHistoryState {
  switch (action.type) {
    case "remember": {
      const command = action.command.trim();
      if (!command) return state;
      const entries = [...state.entries.filter((entry) => entry !== command), command].slice(
        -TERMINAL_HISTORY_LIMIT,
      );
      return { entries, index: -1, draft: "" };
    }
    case "up": {
      if (state.entries.length === 0) return state;
      const draft = action.draft ?? state.draft;
      if (state.index === -1) {
        return { ...state, index: state.entries.length - 1, draft };
      }
      return { ...state, index: Math.max(0, state.index - 1), draft };
    }
    case "down": {
      if (state.index === -1) return state;
      const index = state.index + 1;
      if (index >= state.entries.length) {
        return { ...state, index: -1, draft: "" };
      }
      return { ...state, index };
    }
    case "reset":
      return EMPTY_TERMINAL_HISTORY;
    default:
      return state;
  }
}
