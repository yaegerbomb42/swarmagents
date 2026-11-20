import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import {
  FAKE_CLAUDE_APPROVAL_ASSISTANT_TEXT,
  FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES,
  FAKE_CLAUDE_APPROVAL_TRIGGER,
  FAKE_CLAUDE_ASSISTANT_TEXT,
  FAKE_CLAUDE_SESSION_ID,
  FAKE_CLAUDE_TRANSCRIPT_LINES,
} from "./fake-claude.js";

function parseTranscript(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("FakeVmDriver replays the recorded claude stream-json transcript", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("replay-user");

  let stdout = "";
  const result = await driver.exec(
    handle,
    ["claude", "-p", "smoke check", "--output-format", "stream-json", "--verbose"],
    { onStdout: (chunk) => (stdout += chunk) },
  );

  assert.equal(result.exitCode, 0);
  const events = parseTranscript(stdout);
  assert.deepEqual(
    events.map((event) => event.type),
    FAKE_CLAUDE_TRANSCRIPT_LINES.map((line) => (JSON.parse(line) as { type: string }).type),
  );

  const init = events[0] as { subtype?: string; session_id?: string };
  assert.equal(init.subtype, "init");
  assert.equal(init.session_id, FAKE_CLAUDE_SESSION_ID);

  const assistantText = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => {
      const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text);
    });
  assert.ok(assistantText.includes(FAKE_CLAUDE_ASSISTANT_TEXT));

  assert.equal(events[events.length - 1].type, "result");
});

test("FakeVmDriver replays the risky Bash transcript when the prompt asks for a root deletion", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("approval-replay-user");

  let stdout = "";
  const result = await driver.exec(
    handle,
    ["claude", "-p", `Clean up the sandbox root with ${FAKE_CLAUDE_APPROVAL_TRIGGER} now`, "--output-format", "stream-json", "--verbose"],
    { onStdout: (chunk) => (stdout += chunk) },
  );

  assert.equal(result.exitCode, 0);
  const events = parseTranscript(stdout);
  assert.deepEqual(
    events.map((event) => event.type),
    FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES.map((line) => (JSON.parse(line) as { type: string }).type),
  );

  const blocks = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      return message?.content ?? [];
    });
  const text = blocks.find((block) => block.type === "text")?.text;
  assert.equal(text, FAKE_CLAUDE_APPROVAL_ASSISTANT_TEXT);
  const toolUse = blocks.find((block) => block.type === "tool_use");
  assert.equal(toolUse?.name, "Bash");
  assert.deepEqual(toolUse?.input, { command: FAKE_CLAUDE_APPROVAL_TRIGGER });
});

test("FakeVmDriver keeps the benign transcript for prompts without the trigger", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("benign-replay-user");

  let stdout = "";
  await driver.exec(handle, ["claude", "-p", "run a smoke check"], {
    onStdout: (chunk) => (stdout += chunk),
  });

  const events = parseTranscript(stdout);
  assert.deepEqual(
    events.map((event) => event.type),
    FAKE_CLAUDE_TRANSCRIPT_LINES.map((line) => (JSON.parse(line) as { type: string }).type),
  );
});

test("FakeVmDriver can opt out of claude replay", async () => {
  const driver = new FakeVmDriver({ replayClaude: false });
  const handle = await driver.ensure("no-replay-user");

  let stdout = "";
  const result = await driver.exec(handle, ["claude", "-p", "smoke check"], {
    onStdout: (chunk) => (stdout += chunk),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stdout, "");
});
