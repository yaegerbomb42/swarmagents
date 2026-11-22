import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivityLines, toActivityLine, type ActivityLine } from "./activity";
import type { RunStreamItem } from "./useRunStream";

function item(kind: string, data: unknown, seq = 1): RunStreamItem {
  return {
    seq,
    kind,
    data,
    parsed: { id: String(seq), event: kind, data: "" },
    ts: seq,
  };
}

test("tool.call: Bash command humanizes to Running: …", () => {
  const it = item("tool.call", { name: "Bash", input: { command: "npm test" } });
  const mapped = toActivityLine(it);
  assert.ok(mapped);
  assert.equal(mapped?.text, "Running: npm test");
  assert.equal(mapped?.tone, "accent");
});

test("tool.call: file edits humanize to Editing <path>", () => {
  const mapped = toActivityLine(item("tool.call", { name: "Edit", input: { file_path: "src/app.tsx" } }));
  assert.equal(mapped?.text, "Editing src/app.tsx");
  assert.equal(mapped?.tone, "accent");

  const viaPath = toActivityLine(item("tool.call", { name: "Write", input: { path: "/workspace/readme.md" } }));
  assert.equal(viaPath?.text, "Editing /workspace/readme.md");
});

test("tool.call: browser navigation humanizes to Opening <url>", () => {
  const mapped = toActivityLine(item("tool.call", { name: "BrowserNavigate", input: { url: "https://example.com" } }));
  assert.equal(mapped?.text, "Opening https://example.com");
  assert.equal(mapped?.tone, "accent");
});

test("tool.call: unknown tools fall back to Using <name>", () => {
  const mapped = toActivityLine(item("tool.call", { name: "Grep", input: { pattern: "foo" } }));
  assert.equal(mapped?.text, "Using Grep");
});

test("computer.action: renders the human-readable desktop synopsis", () => {
  const mapped = toActivityLine(item("computer.action", { action: "Clicking at (100, 200)", x: 100, y: 200 }));
  assert.ok(mapped);
  assert.equal(mapped?.kind, "computer.action");
  assert.equal(mapped?.text, "Clicking at (100, 200)");
  assert.equal(mapped?.tone, "accent");
});

test("computer.action: missing action falls back to nothing", () => {
  assert.equal(toActivityLine(item("computer.action", { x: 1 })), null);
});

test("tool.call: long inputs are truncated", () => {
  const long = "x".repeat(400);
  const mapped = toActivityLine(item("tool.call", { name: "Bash", input: { command: long } }));
  assert.ok(mapped?.text.length! < 200, "expected truncated text");
  assert.ok(mapped?.text.endsWith("…"), "expected ellipsis on truncated text");
});

test("tool.result: ok resolves the tool name via the call id", () => {
  const call = item("tool.call", { id: "toolu_1", name: "Bash", input: { command: "ls" } }, 1);
  const result = item("tool.result", { id: "toolu_1", ok: true, output: "a b c" }, 2);
  assert.equal(toActivityLine(result, new Map([["toolu_1", "Bash"]]))?.text, "Bash done");
  assert.equal(toActivityLine(result, new Map([["toolu_1", "Bash"]]))?.tone, "done");
  // Without the call map the tool name is not known.
  const fallback = toActivityLine(result);
  assert.equal(fallback?.text, "Tool done");
});

test("tool.result: failure is an error-toned line", () => {
  const result = item("tool.result", { id: "toolu_2", ok: false, output: "boom" }, 2);
  const mapped = toActivityLine(result, new Map([["toolu_2", "Edit"]]));
  assert.equal(mapped?.text, "Edit failed");
  assert.equal(mapped?.tone, "error");
});

test("approval.required: asks for the user's decision", () => {
  const mapped = toActivityLine(
    item("approval.required", { approval: { action: "rm -rf /", tool: "Bash" } }),
  );
  assert.equal(mapped?.text, "Waiting for your approval · rm -rf /");
  assert.equal(mapped?.tone, "accent");
});

test("approval.resolved: approved/denied verdicts", () => {
  const approved = toActivityLine(item("approval.resolved", { verdict: "approved" }));
  assert.equal(approved?.text, "Approval approved");
  assert.equal(approved?.tone, "done");
  const denied = toActivityLine(item("approval.resolved", { verdict: "denied" }));
  assert.equal(denied?.tone, "error");
});

test("approval.timeout: auto-denied line", () => {
  const mapped = toActivityLine(item("approval.timeout", { id: "ap_1" }));
  assert.equal(mapped?.text, "Approval timed out · auto-denied");
  assert.equal(mapped?.tone, "error");
});

test("assistant.text: short text surfaces as-is", () => {
  const mapped = toActivityLine(item("assistant.text", { text: "Smoke check complete" }));
  assert.equal(mapped?.text, "Smoke check complete");
  assert.equal(mapped?.tone, "default");
});

test("run.finished: exit code and cost", () => {
  const mapped = toActivityLine(
    item("run.finished", { exitCode: 0, durationMs: 4200, costUsd: 0.001 }),
  );
  assert.equal(mapped?.text, "Done · exit 0 · 4.2s · $0.001");
  assert.equal(mapped?.tone, "done");
  const nonzero = toActivityLine(item("run.finished", { exitCode: 1 }));
  assert.equal(nonzero?.tone, "error");
});

test("run.error and run.cancelled are error-toned", () => {
  assert.equal(toActivityLine(item("run.error", { message: "boom" }))?.text, "Error · boom");
  assert.equal(toActivityLine(item("run.cancelled", { reason: "superseded" }))?.text, "Stopped (superseded)");
});

test("VM lifecycle lines", () => {
  assert.equal(toActivityLine(item("vm.starting", {}))?.text, "VM starting · booting isolated sandbox");
  assert.equal(toActivityLine(item("vm.ready", {}))?.tone, "done");
  assert.equal(
    toActivityLine(item("vm.error", { message: "kernel panic" }))?.text,
    "VM error · kernel panic",
  );
});

test("usage and unknown kinds produce no line", () => {
  assert.equal(toActivityLine(item("usage", { inputTokens: 5, outputTokens: 2 })), null);
  assert.equal(toActivityLine(item("mystery.event", {})), null);
});

test("buildActivityLines pairs tool results and caps the list", () => {
  const items: RunStreamItem[] = [
    item("run.started", { model: "claude-sonnet-5-5" }, 1),
    item("tool.call", { id: "toolu_1", name: "Bash", input: { command: "uname -a" } }, 2),
    item("tool.result", { id: "toolu_1", ok: true, output: "Linux" }, 3),
    item("run.finished", { exitCode: 0 }, 4),
  ];
  const lines = buildActivityLines(items);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["Run started · claude-sonnet-5-5", "Running: uname -a", "Bash done", "Done · exit 0"],
  );
  assert.equal(lines[3]?.tone, "done");

  // Capping keeps only the newest lines; extra events are dropped first.
  const many = Array.from({ length: 30 }, (_, i) => item("assistant.text", { text: `t${i}` }, i + 1));
  const capped = buildActivityLines(many, 4);
  assert.equal(capped.length, 4);
  assert.equal(capped[0]?.text, "t26");
  assert.equal(capped[3]?.text, "t29");
});

test("activity lines carry stable keys", () => {
  const lines: ActivityLine[] = [
    toActivityLine(item("run.started", { model: "m" }, 1))!,
    toActivityLine(item("tool.call", { name: "Bash", input: { command: "ls" } }, 2))!,
  ];
  assert.equal(lines[0]?.key, "run.started:1");
  assert.equal(lines[1]?.key, "tool.call:2");
});

test("tool.backgrounded: warns that output won't stream", () => {
  const mapped = toActivityLine(
    item("tool.backgrounded", {
      name: "Bash",
      command: "sleep 60 &",
      hint: "Run it in the foreground.",
    }),
  );
  assert.ok(mapped);
  assert.equal(mapped?.kind, "tool.backgrounded");
  assert.ok(mapped?.text.startsWith("Backgrounded — output won't stream"));
  assert.ok(mapped?.text.includes("sleep 60 &"));
  assert.equal(mapped?.tone, "error");
});

test("tool.backgrounded: missing command still warns", () => {
  const mapped = toActivityLine(item("tool.backgrounded", { name: "Bash", hint: "x" }));
  assert.equal(mapped?.text, "Backgrounded work — output won't stream");
});

test("computer.action: browser opens render as Opening <url>", () => {
  const mapped = toActivityLine(
    item("computer.action", { action: "browser.open", url: "https://example.com" }),
  );
  assert.equal(mapped?.text, "Opening https://example.com");
  assert.equal(mapped?.tone, "accent");
});

test("computer.action: pointer clicks name target or coordinates", () => {
  const byTarget = toActivityLine(item("computer.action", { action: "click", target: "Submit button" }));
  assert.equal(byTarget?.text, "Clicking Submit button");

  const byPoint = toActivityLine(item("computer.action", { action: "click", x: 320, y: 240 }));
  assert.equal(byPoint?.text, "Clicking at (320, 240)");

  const bare = toActivityLine(item("computer.action", { action: "double_click" }));
  assert.equal(bare?.text, "Clicking");
});

test("computer.action: typing renders a character count, never the typed text", () => {
  const typing = toActivityLine(item("computer.action", { action: "type", text: "hello world" }));
  assert.equal(typing?.text, "Typing (11 chars)");
  assert.ok(!typing?.text.includes("hello"), "typed content must not reach the ticker");

  // The structured length (desktop action overlays) wins over the text,
  // and works without the text field at all.
  const byLength = toActivityLine(item("computer.action", { action: "type", text: "hello world", textLength: 42 }));
  assert.equal(byLength?.text, "Typing (42 chars)");
  const lengthOnly = toActivityLine(item("computer.action", { action: "type", textLength: 7 }));
  assert.equal(lengthOnly?.text, "Typing (7 chars)");

  const key = toActivityLine(item("computer.action", { action: "key", text: "Enter" }));
  assert.equal(key?.text, "Pressing Enter");
});

test("computer.action: summary-style events never append the typed text as detail", () => {
  // Real events carry a human-readable summary in `action` and the typed
  // content in `text`; the fallback must not echo the content back.
  const mapped = toActivityLine(item("computer.action", { action: "Typing (6 chars)", text: "secret" }));
  assert.equal(mapped?.text, "Typing (6 chars)");
  assert.ok(!mapped?.text.includes("secret"), "typed content must not reach the ticker");

  // Unknown actions keep their target detail but never a text detail.
  const unknown = toActivityLine(item("computer.action", { action: "hover", text: "secret" }));
  assert.equal(unknown?.text, "Hover");
});

test("computer.action: key combos render sanitized to the keysym charset", () => {
  const combo = toActivityLine(item("computer.action", { action: "key", text: "ctrl+l" }));
  assert.equal(combo?.text, "Pressing ctrl+l");

  const smuggled = toActivityLine(item("computer.action", { action: "key", text: "ctrl+l; rm -rf /" }));
  assert.equal(smuggled?.text, "Pressing ctrl+lrm-rf");
  assert.ok(!smuggled?.text.includes(";"), "non-charset characters must be stripped");
  assert.ok(!smuggled?.text.includes("rm -rf"), "smuggled free text must not survive sanitization");

  // A combo that sanitizes to nothing falls back to the plain action line.
  const empty = toActivityLine(item("computer.action", { action: "key", text: "!!!" }));
  assert.equal(empty?.text, "Key");
});

test("computer.action: scrolling and unknown actions get readable fallbacks", () => {
  const scroll = toActivityLine(item("computer.action", { action: "scroll", target: "page" }));
  assert.equal(scroll?.text, "Scrolling page");

  const unknown = toActivityLine(item("computer.action", { action: "browser.back", target: "docs page" }));
  assert.equal(unknown?.text, "Browser back · docs page");
});

test("computer.action: unknown action with no detail is still readable", () => {
  const mapped = toActivityLine(item("computer.action", { action: "hover" }));
  assert.equal(mapped?.text, "Hover");
});

test("checkpoint.created: branch point line names the label and the guarded tool", () => {
  const mapped = toActivityLine(item("checkpoint.created", { label: "auto-pre-step-4", tool: "Bash", reason: "destructive root deletion requires approval" }));
  assert.equal(mapped?.text, "Checkpoint auto-pre-step-4 · before Bash");
  assert.equal(mapped?.tone, "done");
});

test("checkpoint.failed: failure is visible, not silent", () => {
  const mapped = toActivityLine(item("checkpoint.failed", { label: "auto-pre-step-4", error: "docker commit failed" }));
  assert.equal(mapped?.text, "Checkpoint auto-pre-step-4 failed · docker commit failed");
  assert.equal(mapped?.tone, "error");
});

test("checkpoint.restored: fork provenance reads as a branch line", () => {
  const mapped = toActivityLine(item("checkpoint.restored", { label: "auto-pre-step-4", sourceRunId: "run_x" }));
  assert.equal(mapped?.text, "Forked from auto-pre-step-4");
  assert.equal(mapped?.tone, "accent");
});
