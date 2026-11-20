import test from "node:test";
import assert from "node:assert/strict";
import { reduceRunReplay, type ReplayEvent } from "./runReplay";

function fixture(): ReplayEvent[] {
  return [
    { seq: 1, type: "assistant.text", ts: 1, data: { text: "Plan" } },
    { seq: 2, type: "tool.call", ts: 2, data: { name: "Write", input: { file_path: "src/a.ts", content: "first" } } },
    { seq: 3, type: "tool.result", ts: 3, data: { output: "wrote first", ok: true } },
    ...Array.from({ length: 500 }, (_, i) => ({ seq: i + 4, type: "tool.result", ts: i + 4, data: { output: `line-${i}`, ok: true } })),
    { seq: 504, type: "tool.call", ts: 504, data: { name: "Edit", input: { path: "src/a.ts", old_string: "first", new_string: "second" } } },
    { seq: 505, type: "tool.result", ts: 505, data: { output: "edit failed", ok: false } },
  ];
}

test("run replay reducer reconstructs a prefix at any sequence", () => {
  const events = fixture();
  const before = reduceRunReplay(events, 3);
  assert.equal(before.terminal, "wrote first\n");
  assert.equal(before.reasoning, "Plan\n");
  assert.deepEqual(before.files, [{ path: "src/a.ts", change: "+ first" }]);
  assert.equal(before.markers.length, 1);

  const atEnd = reduceRunReplay(events, 505);
  assert.equal(atEnd.terminal.includes("line-499"), true);
  assert.deepEqual(atEnd.files, [{ path: "src/a.ts", change: "- first\n+ second" }]);
  assert.equal(atEnd.markers.some((marker) => marker.type === "error" && marker.seq === 505), true);
  assert.equal(reduceRunReplay(events, 0).terminal, "");
});

test("checkpoint events become branch-point markers in the replay timeline", () => {
  const events: ReplayEvent[] = [
    { seq: 1, type: "tool.call", ts: 1, data: { name: "Bash", input: { command: "rm -rf /" } } },
    { seq: 2, type: "checkpoint.created", ts: 2, data: { label: "auto-pre-step-2", tool: "Bash" } },
    { seq: 3, type: "checkpoint.restored", ts: 3, data: { label: "auto-pre-step-2", sourceRunId: "run_src" } },
  ];
  const state = reduceRunReplay(events, 3);
  assert.deepEqual(
    state.markers.filter((m) => m.type === "checkpoint").map((m) => ({ seq: m.seq, label: m.label })),
    [
      { seq: 2, label: "auto-pre-step-2" },
      { seq: 3, label: "forked from auto-pre-step-2" },
    ],
  );
});
