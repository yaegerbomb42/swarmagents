/**
 * Unit tests for the git smart committer (lib/harness/git-committer.ts).
 *
 * The acceptance criteria this locks in:
 *   - no staged changes -> success:false, no LLM call, no commit;
 *   - happy path: fake diff -> fake completion -> the commit argv carries
 *     exactly the model's message and filesCommitted is parsed;
 *   - a quoted model reply has its quotes stripped;
 *   - an LLM failure (503 / no providers) commits nothing;
 *   - an oversized diff is sliced before the prompt;
 *   - autoStageAll:false skips `git add -u`;
 *   - a root commit (no HEAD~1) still reports its files via `git show`.
 *
 * Both deps are fakes: `exec` is scripted per git subcommand and records
 * every argv array; `forward` mirrors the board-agent test's fake gateway.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LlmCompletion, LlmForwardOptions } from "../runtime/llm-gateway";
import {
  DEFAULT_MAX_DIFF_CHARS,
  smartCommit,
  type GitExecResult,
  type SmartCommitDeps,
} from "./git-committer";

const USER = "alice";
const DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,3 +10,4 @@",
  "-  if (token.expired) return deny();",
  "+  if (!token || token.expired) return deny();",
].join("\n");

interface ExecCall {
  userId: string;
  cmd: string[];
}

function ok(stdout = ""): GitExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): GitExecResult {
  return { stdout: "", stderr, exitCode };
}

/**
 * A fake VM exec answering each git subcommand from `script` (keyed by the
 * second argv element, e.g. "diff", "commit", "show"; "diff" answers both
 * --cached and --name-only by inspecting the full argv). Unscripted calls
 * succeed with empty output. Every call is recorded.
 */
function fakeExec(script: Partial<Record<string, GitExecResult>> = {}) {
  const calls: ExecCall[] = [];
  const exec: SmartCommitDeps["exec"] = async (userId, cmd) => {
    calls.push({ userId, cmd });
    const key = cmd[1] ?? "";
    if (key === "diff" && cmd.includes("--name-only")) {
      return script["diff --name-only"] ?? ok("src/auth.ts\n");
    }
    if (key === "diff" && cmd.includes("--cached")) {
      return script["diff --cached"] ?? ok(DIFF);
    }
    if (key === "commit") return script.commit ?? ok("[main abc1234] committed\n");
    if (key === "add") return script.add ?? ok();
    if (key === "show") return script.show ?? ok("src/auth.ts\n");
    return ok();
  };
  return { exec, calls };
}

function completion(text: string): LlmCompletion {
  return {
    body: { content: [{ type: "text", text }] },
    usage: { inputTokens: 10, outputTokens: 10 },
    attempts: [],
  };
}

function fakeForward(reply: string) {
  const calls: LlmForwardOptions[] = [];
  const forward = async (options: LlmForwardOptions): Promise<LlmCompletion> => {
    calls.push(options);
    return completion(reply);
  };
  return { forward, calls };
}

test("no staged changes -> success:false, no LLM call, no commit", async () => {
  const { exec, calls } = fakeExec({ "diff --cached": ok("") });
  const llm = fakeForward("fix(auth): handle expired token");

  const result = await smartCommit(USER, { exec, forward: llm.forward });

  assert.deepEqual(result, {
    success: false,
    commitMessage: "",
    filesCommitted: [],
    output: "No staged changes to commit.",
  });
  assert.equal(llm.calls.length, 0, "the model is never asked");
  assert.ok(
    !calls.some((call) => call.cmd[1] === "commit"),
    "nothing is committed",
  );
});

test("happy path: exact message lands in the commit argv, files parsed", async () => {
  const { exec, calls } = fakeExec();
  const llm = fakeForward("fix(auth): handle expired token");

  const result = await smartCommit(USER, { exec, forward: llm.forward });

  assert.equal(result.success, true);
  assert.equal(result.commitMessage, "fix(auth): handle expired token");
  assert.deepEqual(result.filesCommitted, ["src/auth.ts"]);
  assert.match(result.output, /committed/);

  // The LLM call carries the run owner (per-user BYOK) and the routed model.
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].owner, USER);
  assert.equal(llm.calls[0].useRoutedModel, true);
  const body = llm.calls[0].body as {
    system: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
    temperature: number;
    stream: boolean;
  };
  assert.match(body.system, /conventional commit message/);
  assert.equal(body.max_tokens, 50);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /src\/auth\.ts/);

  // git runs as argv arrays, in order: add, diff, commit, name-only.
  assert.deepEqual(
    calls.map((call) => call.cmd),
    [
      ["git", "add", "-u"],
      ["git", "diff", "--cached"],
      ["git", "commit", "-m", "fix(auth): handle expired token"],
      ["git", "diff", "--name-only", "HEAD~1"],
    ],
  );
  assert.ok(calls.every((call) => call.userId === USER));
});

test("a quoted model reply has its quotes stripped", async () => {
  const { exec, calls } = fakeExec();
  const llm = fakeForward('"fix(auth): handle expired token"');

  const result = await smartCommit(USER, { exec, forward: llm.forward });

  assert.equal(result.success, true);
  assert.equal(result.commitMessage, "fix(auth): handle expired token");
  const commit = calls.find((call) => call.cmd[1] === "commit");
  assert.deepEqual(commit?.cmd, ["git", "commit", "-m", "fix(auth): handle expired token"]);
});

test("LLM failure (503, no providers) -> success:false, nothing committed", async () => {
  const { exec, calls } = fakeExec();
  const forward = async (): Promise<LlmCompletion> => {
    // The gateway's empty-pool failure: a structured 503 with no attempts.
    throw { status: 503, body: "{}", attempts: [] };
  };

  const result = await smartCommit(USER, { exec, forward });

  assert.equal(result.success, false);
  assert.equal(result.commitMessage, "");
  assert.deepEqual(result.filesCommitted, []);
  assert.match(result.output, /No LLM provider is configured/);
  assert.ok(
    !calls.some((call) => call.cmd[1] === "commit"),
    "nothing is committed",
  );
});

test("oversized diff is sliced before the prompt", async () => {
  const huge = "x".repeat(DEFAULT_MAX_DIFF_CHARS * 4);
  const { exec } = fakeExec({ "diff --cached": ok(huge) });
  const llm = fakeForward("chore: big change");

  const result = await smartCommit(USER, { exec, forward: llm.forward });

  assert.equal(result.success, true);
  const body = llm.calls[0].body as { messages: Array<{ content: string }> };
  const prompt = body.messages[0].content;
  const diffPart = prompt.slice(prompt.indexOf("DIFF:\n") + "DIFF:\n".length);
  assert.equal(diffPart.length, DEFAULT_MAX_DIFF_CHARS);
  assert.ok(prompt.length < huge.length, "the full diff never reaches the model");
});

test("autoStageAll:false skips git add -u", async () => {
  const { exec, calls } = fakeExec();
  const llm = fakeForward("fix(auth): handle expired token");

  const result = await smartCommit(USER, { exec, forward: llm.forward }, { autoStageAll: false });

  assert.equal(result.success, true);
  assert.ok(!calls.some((call) => call.cmd[1] === "add"), "no staging call");
  assert.equal(calls[0].cmd[1], "diff");
});

test("root commit (no HEAD~1) still reports files via git show", async () => {
  const { exec } = fakeExec({
    "diff --name-only": fail("fatal: ambiguous argument 'HEAD~1': unknown revision", 128),
    show: ok("README.md\nsrc/auth.ts\n"),
  });
  const llm = fakeForward("feat: initial commit");

  const result = await smartCommit(USER, { exec, forward: llm.forward });

  assert.equal(result.success, true);
  assert.deepEqual(result.filesCommitted, ["README.md", "src/auth.ts"]);
});
