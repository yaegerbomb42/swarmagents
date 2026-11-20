import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_TERMINAL_HISTORY,
  TERMINAL_HISTORY_LIMIT,
  sanitizeTerminalHistory,
  terminalHistoryReducer,
  terminalHistoryValue,
  type TerminalHistoryState,
} from "./terminalHistory";

function remember(state: TerminalHistoryState, command: string): TerminalHistoryState {
  return terminalHistoryReducer(state, { type: "remember", command });
}

test("remember appends commands newest-last and ignores blank input", () => {
  let state = remember(EMPTY_TERMINAL_HISTORY, "ls -la");
  state = remember(state, "  pwd  ");
  assert.deepEqual(state.entries, ["ls -la", "pwd"]);
  assert.equal(state.index, -1);

  const blank = remember(state, "   ");
  assert.equal(blank, state, "blank commands should not change the state");
});

test("remember de-duplicates and moves the command to the newest slot", () => {
  let state = remember(EMPTY_TERMINAL_HISTORY, "one");
  state = remember(state, "two");
  state = remember(state, "one");
  assert.deepEqual(state.entries, ["two", "one"]);
});

test("history is capped at 100 entries, dropping the oldest", () => {
  let state = EMPTY_TERMINAL_HISTORY;
  for (let i = 0; i < TERMINAL_HISTORY_LIMIT + 5; i += 1) {
    state = remember(state, `cmd-${i}`);
  }
  assert.equal(state.entries.length, TERMINAL_HISTORY_LIMIT);
  assert.equal(TERMINAL_HISTORY_LIMIT, 100);
  assert.equal(state.entries[0], "cmd-5");
  assert.equal(state.entries[state.entries.length - 1], "cmd-104");
});

test("up/down cycle through history and restore the draft at the end", () => {
  let state = remember(EMPTY_TERMINAL_HISTORY, "first");
  state = remember(state, "second");
  state = remember(state, "third");

  state = terminalHistoryReducer(state, { type: "up", draft: "partial" });
  assert.equal(terminalHistoryValue(state), "third");
  state = terminalHistoryReducer(state, { type: "up", draft: "partial" });
  assert.equal(terminalHistoryValue(state), "second");
  state = terminalHistoryReducer(state, { type: "up", draft: "partial" });
  assert.equal(terminalHistoryValue(state), "first");
  // Up at the oldest entry stays put.
  state = terminalHistoryReducer(state, { type: "up", draft: "partial" });
  assert.equal(terminalHistoryValue(state), "first");

  state = terminalHistoryReducer(state, { type: "down" });
  assert.equal(terminalHistoryValue(state), "second");
  state = terminalHistoryReducer(state, { type: "down" });
  assert.equal(terminalHistoryValue(state), "third");
  state = terminalHistoryReducer(state, { type: "down" });
  assert.equal(state.index, -1);
  assert.equal(terminalHistoryValue(state), "", "draft is cleared after browsing");

  // Down while not browsing is a no-op.
  assert.equal(terminalHistoryReducer(state, { type: "down" }), state);
});

test("remembering a command resets browsing to the newest end", () => {
  let state = remember(EMPTY_TERMINAL_HISTORY, "first");
  state = remember(state, "second");
  state = terminalHistoryReducer(state, { type: "up", draft: "draft" });
  state = remember(state, "third");
  assert.equal(state.index, -1);
  assert.equal(terminalHistoryValue(state), "");
  assert.deepEqual(state.entries, ["first", "second", "third"]);
});

test("reset clears the whole history", () => {
  let state = remember(EMPTY_TERMINAL_HISTORY, "secret");
  state = terminalHistoryReducer(state, { type: "reset" });
  assert.deepEqual(state, EMPTY_TERMINAL_HISTORY);
});

test("sanitize accepts old array storage and rejects malformed state", () => {
  assert.deepEqual(sanitizeTerminalHistory(["a", 3, "", "b"]), {
    entries: ["a", "b"],
    index: -1,
    draft: "",
  });
  assert.deepEqual(
    sanitizeTerminalHistory({ entries: ["a", "b"], index: 7, draft: 42 }),
    { entries: ["a", "b"], index: -1, draft: "" },
  );
  assert.deepEqual(sanitizeTerminalHistory("nonsense"), EMPTY_TERMINAL_HISTORY);
});

test("sanitize caps oversized persisted arrays", () => {
  const stored = Array.from({ length: TERMINAL_HISTORY_LIMIT + 10 }, (_, i) => `cmd-${i}`);
  const state = sanitizeTerminalHistory(stored);
  assert.equal(state.entries.length, TERMINAL_HISTORY_LIMIT);
  assert.equal(state.entries[0], "cmd-10");
});
