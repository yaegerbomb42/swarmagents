/**
 * Tests for the auto-test generator (lib/harness/auto-test.ts) with a fake
 * VM exec and a fake LLM forward — no VM, no provider, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_TEST_TIMEOUT_MS,
  extractTestCode,
  generateAndRunVerificationTest,
  testPathFor,
  type AutoTestDeps,
  type AutoTestExecResult,
} from "./auto-test";
import type { forwardLlmNonStreaming } from "../runtime/llm-gateway";

const USER = "user-1";
const TARGET = "/workspace/src/math.js";

const MATH_JS = [
  "// math helpers",
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export function clamp(value, min, max) {",
  "  return Math.min(max, Math.max(min, value));",
  "}",
  "",
].join("\n");

const FENCED_TEST = [
  "Here is the test:",
  "```javascript",
  "import assert from 'node:assert';",
  "import { add } from './math.js';",
  "assert.equal(add(2, 3), 5);",
  "console.log('TEST_PASSED');",
  "```",
].join("\n");

interface ExecCall {
  cmd: string[];
  opts?: { timeoutMs?: number; stdin?: string };
}

interface FakeExecScript {
  cat?: AutoTestExecResult;
  tee?: AutoTestExecResult;
  node?: AutoTestExecResult;
}

/** Scripted VM exec: records every call, answers by command name. */
function fakeExec(script: FakeExecScript = {}) {
  const calls: ExecCall[] = [];
  const exec: AutoTestDeps["exec"] = async (_userId, cmd, opts) => {
    calls.push({ cmd, opts });
    if (cmd[0] === "cat") return script.cat ?? { stdout: MATH_JS, stderr: "", exitCode: 0 };
    if (cmd[0] === "tee") return script.tee ?? { stdout: opts?.stdin ?? "", stderr: "", exitCode: 0 };
    if (cmd[0] === "node") return script.node ?? { stdout: "TEST_PASSED\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: `unexpected command: ${cmd.join(" ")}`, exitCode: 127 };
  };
  return { exec, calls };
}

/** Fake gateway forward returning one Anthropic-shaped text completion. */
function fakeForward(text: string) {
  const seen: Array<{ owner: string; body: unknown }> = [];
  const forward = (async (options: { owner: string; body: unknown }) => {
    seen.push({ owner: options.owner, body: options.body });
    return {
      body: { content: [{ type: "text", text }] },
      usage: { inputTokens: 10, outputTokens: 20 },
      attempts: [],
    };
  }) as unknown as typeof forwardLlmNonStreaming;
  return { forward, seen };
}

function promptOf(seen: Array<{ body: unknown }>): string {
  const body = seen[0]?.body as { messages?: Array<{ content?: unknown }> } | undefined;
  const content = body?.messages?.[0]?.content;
  return typeof content === "string" ? content : "";
}

test("happy path: fenced test is written beside the target and passes", async () => {
  const { exec, calls } = fakeExec();
  const { forward, seen } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, true);
  assert.equal(result.testPassed, true);
  assert.equal(result.testFilePath, "/workspace/src/temp_add_test.mjs");
  assert.match(result.output, /TEST_PASSED/);

  // Read → write → run, all argv, in order.
  assert.deepEqual(
    calls.map((c) => c.cmd),
    [
      ["cat", "--", TARGET],
      ["tee", "--", "/workspace/src/temp_add_test.mjs"],
      ["node", "/workspace/src/temp_add_test.mjs"],
    ],
  );
  // The fence is stripped; only the code lands in the file (plus a newline).
  assert.equal(
    calls[1].opts?.stdin,
    "import assert from 'node:assert';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('TEST_PASSED');\n",
  );
  // The run is bounded by the 5 s timeout.
  assert.equal(calls[2].opts?.timeoutMs, AUTO_TEST_TIMEOUT_MS);

  // The LLM call carries the run owner (per-user BYOK) and the vendor rules.
  assert.equal(seen[0].owner, USER);
  const prompt = promptOf(seen);
  assert.match(prompt, /TARGET FILE: \/workspace\/src\/math\.js/);
  assert.match(prompt, /import \{ add \} from '\.\/math\.js'/);
  assert.match(prompt, /node:assert/);
  assert.match(prompt, /TEST_PASSED/);
});

test("generated test fails: exit 1 → testPassed false, stderr carried", async () => {
  const { exec } = fakeExec({
    node: { stdout: "", stderr: "AssertionError: 4 !== 5\n    at temp_add_test.mjs:4", exitCode: 1 },
  });
  const { forward } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, true);
  assert.equal(result.testPassed, false);
  assert.match(result.output, /AssertionError: 4 !== 5/);
  assert.match(result.output, /Exited with code 1\./);
});

test("exit 0 without the TEST_PASSED marker is not a pass (tightened)", async () => {
  const { exec } = fakeExec({ node: { stdout: "", stderr: "", exitCode: 0 } });
  const { forward } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, true);
  assert.equal(result.testPassed, false);
  assert.match(result.output, /without printing TEST_PASSED/);
});

test("no code block: the raw reply text is used as-is", async () => {
  const rawCode = "import assert from 'node:assert';\nconsole.log('TEST_PASSED');";
  const { exec, calls } = fakeExec();
  const { forward } = fakeForward(rawCode);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, true);
  assert.equal(result.testPassed, true);
  assert.equal(calls[1].opts?.stdin, `${rawCode}\n`);
});

test("LLM 503 (no providers): success false, no file written, BYOK guidance", async () => {
  const { exec, calls } = fakeExec();
  const forward = (async () => {
    throw { status: 503, body: "{}", attempts: [] };
  }) as unknown as typeof forwardLlmNonStreaming;

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, false);
  assert.equal(result.testPassed, false);
  assert.match(result.output, /No provider is configured\. Add your key in Settings \(BYOK\)/);
  // Only the read happened — nothing was written or run.
  assert.deepEqual(calls.map((c) => c.cmd[0]), ["cat"]);
});

test("LLM error (non-503): success false with the provider message", async () => {
  const { exec, calls } = fakeExec();
  const forward = (async () => {
    throw {
      status: 502,
      body: JSON.stringify({ type: "error", error: { type: "api_error", message: "All LLM providers failed." } }),
      attempts: [{ provider: "x", model: "y", ok: false, latencyMs: 1 }],
    };
  }) as unknown as typeof forwardLlmNonStreaming;

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, false);
  assert.equal(result.output, "All LLM providers failed.");
  assert.deepEqual(calls.map((c) => c.cmd[0]), ["cat"]);
});

test("empty completion: success false, no file written", async () => {
  const { exec, calls } = fakeExec();
  const { forward } = fakeForward("   \n  ");

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, false);
  assert.match(result.output, /no test code/);
  assert.deepEqual(calls.map((c) => c.cmd[0]), ["cat"]);
});

test("slice bounds pass through to readSlice (prompt holds only sliced lines)", async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `// line ${i + 1} marker-${i + 1}`);
  const { exec } = fakeExec({ cat: { stdout: lines.join("\n"), stderr: "", exitCode: 0 } });
  const { forward, seen } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add", startLine: 5, endLine: 7 },
  );

  assert.equal(result.success, true);
  const prompt = promptOf(seen);
  assert.match(prompt, /5 \| \/\/ line 5 marker-5/);
  assert.match(prompt, /7 \| \/\/ line 7 marker-7/);
  assert.doesNotMatch(prompt, /marker-4\b/);
  assert.doesNotMatch(prompt, /marker-8\b/);
});

test("unreadable target: success false, no LLM call", async () => {
  const { exec } = fakeExec({
    cat: { stdout: "", stderr: "cat: /workspace/src/math.js: No such file or directory", exitCode: 1 },
  });
  const { forward, seen } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, false);
  assert.match(result.output, /No such file or directory/);
  assert.equal(seen.length, 0);
});

test("write failure: success false (vendor outer-catch semantics)", async () => {
  const { exec, calls } = fakeExec({
    tee: { stdout: "", stderr: "tee: /workspace/src/temp_add_test.mjs: Read-only file system", exitCode: 1 },
  });
  const { forward } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add" },
  );

  assert.equal(result.success, false);
  assert.match(result.output, /Read-only file system/);
  assert.deepEqual(calls.map((c) => c.cmd[0]), ["cat", "tee"]);
});

test("invalid function name and path traversal are refused before any exec", async () => {
  const { exec, calls } = fakeExec();
  const { forward } = fakeForward(FENCED_TEST);

  const badName = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: TARGET, functionName: "add; rm -rf /" },
  );
  assert.equal(badName.success, false);
  assert.match(badName.output, /Invalid function name/);

  const traversal = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: "/workspace/../etc/passwd", functionName: "add" },
  );
  assert.equal(traversal.success, false);
  assert.match(traversal.output, /traversal|outside|stay inside/i);

  const root = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: "/workspace", functionName: "add" },
  );
  assert.equal(root.success, false);
  assert.match(root.output, /workspace root/);

  assert.equal(calls.length, 0);
});

test("relative target paths resolve under /workspace", async () => {
  const { exec, calls } = fakeExec();
  const { forward } = fakeForward(FENCED_TEST);

  const result = await generateAndRunVerificationTest(
    USER,
    { exec, forward },
    { filePath: "src/math.js", functionName: "add" },
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0].cmd, ["cat", "--", "/workspace/src/math.js"]);
  assert.equal(result.testFilePath, "/workspace/src/temp_add_test.mjs");
});

test("extractTestCode: fence variants and raw fallback", () => {
  assert.equal(extractTestCode("```javascript\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(extractTestCode("```js\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(extractTestCode("```\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(extractTestCode("  const a = 1;  "), "const a = 1;");
  assert.equal(extractTestCode(""), "");
});

test("testPathFor: vendor naming beside the target", () => {
  assert.equal(testPathFor("/workspace/src/math.js", "Add"), "/workspace/src/temp_add_test.mjs");
  assert.equal(testPathFor("/workspace/math.js", "clamp"), "/workspace/temp_clamp_test.mjs");
});
