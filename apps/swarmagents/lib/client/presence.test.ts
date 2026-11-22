import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  derivePresence,
  pastTenseAction,
  presenceFromActivity,
  presenceLabel,
  presenceTone,
} from "./presence";
import type { RunStreamItem } from "./useRunStream";

/** One stream item, with the fields the reducer reads. */
function item(
  seq: number,
  kind: string,
  payload: Record<string, unknown> = {},
  ts = 1_000 + seq,
): RunStreamItem {
  return { seq, kind, data: payload, ts, runId: "run_test" } as unknown as RunStreamItem;
}

describe("derivePresence", () => {
  it("is idle with zero stats for an empty stream", () => {
    const presence = derivePresence([]);
    assert.equal(presence.runState, "idle");
    assert.equal(presence.action, undefined);
    assert.deepEqual(presence.stats, { toolCalls: 0, filesTouched: 0, seq: 0 });
    assert.equal(presenceLabel(presence), "Idle");
    assert.equal(presenceTone(presence), "muted");
  });

  it("names a running command and counts the tool call", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "npm test" } }),
    ]);
    assert.equal(presence.runState, "working");
    assert.equal(presence.action, "Running npm test");
    assert.equal(presence.command, "npm test");
    assert.equal(presence.tool, "Bash");
    assert.equal(presence.stats.toolCalls, 1);
    assert.equal(presenceTone(presence), "accent");
  });

  it("marks the file a successful write touched", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Write", input: { file_path: "/workspace/hello.py" } }),
      item(3, "tool.result", { ok: true }),
    ]);
    assert.equal(presence.wroteFile, "/workspace/hello.py");
    assert.equal(presence.file, "/workspace/hello.py");
    assert.equal(presence.changedAt, 1_003);
    assert.equal(presence.stats.filesTouched, 1);
  });

  it("does not count a failed write as a change", () => {
    const presence = derivePresence([
      item(1, "tool.call", { name: "Write", input: { file_path: "/workspace/hello.py" } }),
      item(2, "tool.result", { ok: false }),
    ]);
    assert.equal(presence.wroteFile, undefined);
    assert.equal(presence.action, "Write failed");
  });

  it("keeps reads out of wroteFile", () => {
    const presence = derivePresence([
      item(1, "tool.call", { name: "Read", input: { file_path: "/workspace/README.md" } }),
      item(2, "tool.result", { ok: true }),
    ]);
    assert.equal(presence.wroteFile, undefined);
    assert.equal(presence.file, "/workspace/README.md");
    assert.equal(presence.action, "Reading /workspace/README.md");
  });

  it("waits on approvals and questions, then clears", () => {
    const waiting = derivePresence([
      item(1, "tool.call", { name: "Bash", input: { command: "rm -rf build" } }),
      item(2, "approval.required", {}),
    ]);
    assert.equal(waiting.runState, "waiting");
    assert.equal(waiting.action, "Waiting for your approval");

    const question = derivePresence([item(1, "question.required", {})]);
    assert.equal(question.runState, "waiting");
    assert.equal(question.action, "Waiting for your answer");

    const resolved = derivePresence([
      item(1, "question.required", {}),
      item(2, "question.resolved", {}),
      item(3, "run.started"),
    ]);
    assert.equal(resolved.runState, "working");
  });

  it("a new run resets a previous finished run", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "uname -a" } }),
      item(3, "run.finished", {}),
      item(4, "run.created", {}),
    ]);
    assert.equal(presence.runState, "working");
  });

  it("a finished run says what it did, in the past tense", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "python3 hello.py" } }),
      item(3, "run.finished", {}),
    ]);
    assert.equal(presence.runState, "done");
    assert.equal(presence.action, "Ran python3 hello.py");
    assert.equal(presenceLabel(presence), "Done");
    assert.equal(presenceTone(presence), "ok");
  });

  it("reports a failure with the message", () => {
    const presence = derivePresence([item(1, "run.error", { message: "Provider key rejected" })]);
    assert.equal(presence.runState, "failed");
    assert.equal(presence.action, "Provider key rejected");
    assert.equal(presenceTone(presence), "err");
  });

  it("reports a cancellation as done", () => {
    const stopped = derivePresence([
      item(1, "run.started"),
      item(2, "run.cancelled", {}),
    ]);
    assert.equal(stopped.runState, "done");
    assert.equal(stopped.action, "Stopped by you");
  });
});

describe("presenceFromActivity", () => {
  it("reads the newest polled activity line", () => {
    const working = presenceFromActivity([{ text: "Running npm test" }], "working");
    assert.equal(working.action, "Running npm test");
    assert.equal(working.command, "npm test");

    const writing = presenceFromActivity([{ text: "Editing hello.py" }], "working");
    assert.equal(writing.file, "hello.py");
    assert.equal(writing.wroteFile, "hello.py");
  });

  it("uses the past tense once the run is done", () => {
    const done = presenceFromActivity([{ text: "Running npm test" }], "done");
    assert.equal(done.action, "Ran npm test");
  });

  it("stays quiet when the line is not an action", () => {
    const presence = presenceFromActivity([{ text: "Waiting for your answer" }], "waiting");
    assert.equal(presence.action, undefined);
    assert.equal(presence.runState, "waiting");
  });
});

describe("pastTenseAction", () => {
  it("maps the verb and keeps the rest untouched", () => {
    assert.equal(pastTenseAction("Running python3 hello.py"), "Ran python3 hello.py");
    assert.equal(pastTenseAction("Editing /workspace/hello.py"), "Edited /workspace/hello.py");
    assert.equal(pastTenseAction("Read"), "Read");
    assert.equal(pastTenseAction("Grep “flask”"), "Grep “flask”");
  });
});
