/**
 * Turn compaction: oversized tool_result payloads are condensed with their
 * diagnostics intact, and multi-turn histories stay inside the token
 * budget no matter how many turns accumulate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../../codebase/tokens";
import {
  DEFAULT_KEEP_RECENT_RESULTS,
  DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
  compactAnthropicMessages,
  compactToolResultText,
  extractSignalLines,
  summarizeCompactedResult,
} from "./turn-compaction";

function toolResultMessage(id: string, content: string): Record<string, unknown> {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }] };
}

/** A DOM snapshot: thousands of identical divs, one buried file path and error. */
function domSnapshot(lines = 3000): string {
  const out: string[] = ["<div id=\"root\">"];
  for (let i = 0; i < lines; i++) {
    out.push(`  <div class="node-${i % 50}" data-x="${i}">lorem ipsum dolor sit amet</div>`);
  }
  out.push("  <!-- rendered from src/components/DesktopView.tsx:36 -->");
  out.push("  <div class=\"error\">Error: screenshot failed with exit code 1</div>");
  out.push("</div>");
  return out.join("\n");
}

/** A jest-style run: 2,000 passing lines, two failures, a summary, an exit code. */
function jestOutput(): string {
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) out.push(`✓ renders row ${i} correctly (3ms)`);
  out.push("FAIL src/components/DesktopView.test.tsx");
  out.push("  ● DesktopView › shows the live desktop");
  out.push("    Expected: live desktop visible");
  out.push("    Received: blank screen");
  out.push("      at Object.<anonymous> (src/components/DesktopView.test.tsx:42:15)");
  out.push("FAIL src/components/ComputerActionOverlay.test.tsx");
  out.push("  ● ComputerActionOverlay › replays the cursor path");
  out.push("    Expected: 12 cursor points");
  out.push("    Received: 0 cursor points");
  out.push("      at Object.<anonymous> (src/components/ComputerActionOverlay.test.tsx:17:8)");
  out.push("Tests:       2 failed, 1998 passed, 2000 total");
  out.push("Test Suites: 2 failed, 2 total");
  out.push("error Command failed with exit code 1.");
  return out.join("\n");
}

test("small histories pass through byte-identical", () => {
  const messages = [
    userMessage("fix the login button"),
    toolResultMessage("tu_1", "ok"),
    toolResultMessage("tu_2", "done"),
  ];
  const result = compactAnthropicMessages(messages);
  assert.equal(result.stats.resultsSeen, 2);
  assert.equal(result.stats.resultsCompacted, 0);
  assert.equal(result.stats.tokensBefore, result.stats.tokensAfter);
  assert.equal(result.messages[0], messages[0]);
  assert.equal(result.messages[1], messages[1]);
  assert.equal(result.messages[2], messages[2]);
});

test("a single oversized result is condensed; paths, error lines and exit codes survive", () => {
  const snapshot = domSnapshot();
  const compacted = compactToolResultText(snapshot);
  assert.ok(compacted.length < snapshot.length, "must shrink");
  assert.ok(compacted.includes("src/components/DesktopView.tsx:36"), "file path survives");
  assert.ok(compacted.includes("exit code 1"), "exit code survives");
  assert.ok(compacted.includes("Error: screenshot failed"), "error line survives");
  assert.ok(estimateTokens(compacted) < estimateTokens(snapshot));
});

test("jest output keeps failing tests, file paths and the exit code", () => {
  const raw = jestOutput();
  const compacted = compactToolResultText(raw);
  assert.ok(compacted.length < raw.length, "must shrink");
  assert.ok(compacted.includes("DesktopView › shows the live desktop"), "failing test survives");
  assert.ok(compacted.includes("ComputerActionOverlay › replays the cursor path"), "second failure survives");
  assert.ok(compacted.includes("src/components/DesktopView.test.tsx:42"), "file:line survives");
  assert.ok(compacted.includes("src/components/ComputerActionOverlay.test.tsx:17"), "second file:line survives");
  assert.ok(compacted.includes("exit code 1"), "exit code survives");
  assert.ok(compacted.includes("2 failed"), "failure tally survives");
  assert.ok(!compacted.includes("renders row 1234 correctly"), "passing-test noise is dropped");
});

test("signal lines: exit codes, file refs and error lines are extracted and capped", () => {
  const lines = extractSignalLines(
    [
      "all good here",
      "error Command failed with exit code 1.",
      "  at foo (src/harness/runner.ts:123:4)",
      "some other noise",
      "exited with code 3",
    ].join("\n"),
  );
  assert.deepEqual(lines, [
    "error Command failed with exit code 1.",
    "at foo (src/harness/runner.ts:123:4)",
    "exited with code 3",
  ]);
});

test("bounded token growth: 30 fat turns stay inside the budget", () => {
  const messages: unknown[] = [userMessage("make the desktop work")];
  for (let turn = 1; turn <= 30; turn++) {
    messages.push(toolResultMessage(`tu_${turn}`, jestOutput()));
    messages.push({ role: "assistant", content: [{ type: "text", text: `turn ${turn} done` }] });
  }
  const before = compactAnthropicMessages(messages);
  assert.ok(before.stats.tokensBefore > DEFAULT_TOOL_RESULT_TOKEN_BUDGET * 3, "fixture must start far over budget");
  assert.ok(
    before.stats.tokensAfter <= DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
    `compacted total ${before.stats.tokensAfter} must fit the ${DEFAULT_TOOL_RESULT_TOKEN_BUDGET} budget`,
  );
  assert.ok(before.stats.resultsCompacted > 0, "old results were compacted");
  assert.equal(before.stats.resultsSeen, 30);
});

test("with a small budget the oldest results are summarized and the newest keep diagnostics", () => {
  const messages: unknown[] = [userMessage("make the desktop work")];
  for (let turn = 1; turn <= 30; turn++) {
    messages.push(toolResultMessage(`tu_${turn}`, jestOutput()));
  }
  const result = compactAnthropicMessages(messages, {
    maxToolResultTokens: 4000,
    perResultTokenCap: 1000,
    keepRecentResults: 2,
  });
  assert.ok(result.stats.tokensAfter <= 4000, `compacted total ${result.stats.tokensAfter} must fit the small budget`);

  const out = result.messages as Array<Record<string, unknown>>;
  const lastResults = out
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b.type === "tool_result"));
  const textOf = (block: Record<string, unknown>): string =>
    typeof block.content === "string" ? block.content : JSON.stringify(block.content);

  // The newest results are never summarized away: they keep condensed
  // diagnostics, not a one-line stub.
  const newest = lastResults.at(-1)!;
  const newestText = textOf(newest);
  assert.ok(!newestText.includes("[tool result compacted:"), "newest result is not summarized");
  assert.ok(newestText.includes("exit code 1"), "newest result keeps its exit code");

  // And the oldest result is summarized (its diagnostic value is spent).
  const oldestText = textOf(lastResults[0]!);
  assert.ok(oldestText.includes("[tool result compacted:"), "oldest result is summarized");
});

test("growth plateaus: doubling the turns does not double the compacted total", () => {
  const options = { maxToolResultTokens: 4000, perResultTokenCap: 1000, keepRecentResults: 2 };
  const build = (turns: number): unknown[] => {
    const messages: unknown[] = [userMessage("work")];
    for (let turn = 1; turn <= turns; turn++) {
      messages.push(toolResultMessage(`tu_${turn}`, jestOutput()));
    }
    return messages;
  };
  const fifteen = compactAnthropicMessages(build(15), options).stats.tokensAfter;
  const thirty = compactAnthropicMessages(build(30), options).stats.tokensAfter;
  const sixty = compactAnthropicMessages(build(60), options).stats.tokensAfter;
  assert.ok(fifteen <= 4000, "15 turns fit");
  assert.ok(thirty <= 4000, "30 turns fit");
  assert.ok(sixty <= 4000, "60 turns fit");
  // The compacted total plateaus at the budget instead of growing with
  // the turn count: 4x the turns, roughly the same total.
  assert.ok(sixty < fifteen * 1.5, `60 turns (${sixty}) must stay near the 15-turn total (${fifteen})`);
});

test("custom small budget enforces its own bound", () => {
  const messages: unknown[] = [];
  for (let turn = 1; turn <= 10; turn++) {
    messages.push(toolResultMessage(`tu_${turn}`, jestOutput()));
  }
  const result = compactAnthropicMessages(messages, {
    maxToolResultTokens: 1000,
    perResultTokenCap: 200,
    keepRecentResults: 1,
  });
  assert.ok(
    result.stats.tokensAfter <= 1000 + 1 * 200,
    `compacted total ${result.stats.tokensAfter} must respect the small budget + window`,
  );
  assert.ok(result.stats.tokensAfter < result.stats.tokensBefore);
});

test("non-tool content is never rewritten", () => {
  const assistantWithToolUse = {
    role: "assistant",
    content: [
      { type: "text", text: "checking the desktop now" },
      { type: "tool_use", id: "tu_x", name: "screenshot", input: { full: true } },
    ],
  };
  const imageResult = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_x", content: "ok" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ],
  };
  const messages = [assistantWithToolUse, imageResult, toolResultMessage("tu_y", jestOutput())];
  const result = compactAnthropicMessages(messages);
  assert.equal(result.messages[0], messages[0], "assistant message untouched");
  const outImage = result.messages[1] as Record<string, unknown>;
  const imageBlock = (outImage.content as Array<Record<string, unknown>>).find((b) => b.type === "image");
  assert.equal(imageBlock?.source, (imageResult.content[1] as Record<string, unknown>).source, "image block untouched");
});

test("input messages are never mutated", () => {
  const messages = [userMessage("work"), toolResultMessage("tu_1", jestOutput())];
  const snapshot = JSON.stringify(messages);
  compactAnthropicMessages(messages);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("summarizeCompactedResult keeps a trace of the original", () => {
  const summary = summarizeCompactedResult("npm test\n✓ ok\nFAIL src/x.test.ts:12", 1234);
  assert.ok(summary.includes("npm test"), "first line survives");
  assert.ok(summary.includes("1234 tokens omitted"), "omitted count survives");
});

test("short results pass through compactToolResultText unchanged", () => {
  assert.equal(compactToolResultText("ok"), "ok");
  assert.equal(compactToolResultText(""), "");
});

test("per-result cap condenses even the newest result", () => {
  const messages = [toolResultMessage("tu_1", jestOutput())];
  const raw = jestOutput();
  const result = compactAnthropicMessages(messages, {
    maxToolResultTokens: DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
    perResultTokenCap: 100,
    keepRecentResults: DEFAULT_KEEP_RECENT_RESULTS,
  });
  assert.equal(result.stats.resultsCompacted, 1);
  const out = result.messages[0] as Record<string, unknown>;
  const block = (out.content as Array<Record<string, unknown>>)[0];
  const text = typeof block.content === "string" ? block.content : "";
  assert.ok(text.length < raw.length, "result shrank");
  assert.ok(text.includes("exit code 1"), "exit code survives the per-result condensation");
});
