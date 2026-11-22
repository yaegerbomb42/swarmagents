/**
 * Auto-test generator (host-side): slice a function out of a file in the
 * user's VM, ask the user's own provider to write a standalone Node
 * assertion script for it, write the script next to the target inside the
 * VM, run it there with a hard timeout, and report pass/fail with output —
 * a quick "does this function actually work" check.
 *
 * Ported from vendor/claude-code-mini/src/autoTestGenerator.ts:
 *   - GroqClient/keypool → forwardLlmNonStreaming (the per-user BYOK
 *     gateway; the vendor's GroqClient does NOT come along).
 *   - Host fs/execSync → VmManager exec (argv only). The generated test
 *     executes ONLY inside the user's VM, never on the host.
 *   - AstSlicer.readSlice(path) → the ported readSlice({path, content});
 *     the caller reads the file out of the VM first (vm exec `cat`).
 *
 * Two deliberate tightenings over the vendor:
 *   - testPassed requires exit 0 AND the TEST_PASSED marker (the vendor
 *     also accepted empty output, so a no-op script "passed").
 *   - an empty model completion is a failure (success:false) instead of
 *     an empty file that trivially "passes".
 *
 * Result semantics mirror the vendor: success=false means the pipeline
 * itself failed (bad input, unreadable target, provider error, write
 * error); success=true + testPassed=false means the generated test ran
 * and failed. This function never throws.
 */

import path from "node:path";
import { forwardLlmNonStreaming } from "../runtime/llm-gateway";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "../vm/files";
import { getVmManager, type VmManager } from "../vm/manager";
import { readSlice } from "./context/astSlicer";
import { makeRedactor } from "./redact";

export interface TestGenResult {
  success: boolean;
  testFilePath: string;
  testPassed: boolean;
  output: string;
}

/** Result of one VM exec, with stdout/stderr accumulated by the wrapper. */
export interface AutoTestExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AutoTestDeps {
  exec: (
    userId: string,
    cmd: string[],
    opts?: { timeoutMs?: number; stdin?: string },
  ) => Promise<AutoTestExecResult>;
  forward?: typeof forwardLlmNonStreaming;
}

export interface AutoTestTarget {
  filePath: string;
  functionName: string;
  startLine?: number;
  endLine?: number;
}

/** Hard bound on the generated test's runtime inside the VM (vendor: 5 s). */
export const AUTO_TEST_TIMEOUT_MS = 5000;

const DEFAULT_START_LINE = 1;
const DEFAULT_END_LINE = 60;
const NO_PROVIDER_OUTPUT =
  "No provider is configured. Add your key in Settings (BYOK) before I can run.";
const FUNCTION_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CODE_BLOCK_RE = /```(?:javascript|js)?\s*([\s\S]*?)```/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assistant text out of a gateway completion body. The gateway normalizes
 * every provider to Anthropic content blocks; the OpenAI `choices`
 * fallback keeps a shape drift from silently emptying the reply. (Copied
 * from lib/board-agent/agent.ts, where it is not exported.)
 */
function completionText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!isRecord(body)) return "";
  if (Array.isArray(body.content)) {
    return body.content
      .map((block: unknown) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
      )
      .join("");
  }
  if (Array.isArray(body.choices)) {
    const first: unknown = body.choices[0];
    if (isRecord(first) && isRecord(first.message) && typeof first.message.content === "string") {
      return first.message.content;
    }
  }
  return "";
}

/** Human-readable message out of an Error or a gateway LlmFailure throw. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err)) {
    if (typeof err.message === "string" && err.message) return err.message;
    if (typeof err.body === "string") {
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
          return parsed.error.message;
        }
      } catch {
        // Not JSON — fall through and return the raw body.
      }
      return err.body;
    }
  }
  return String(err);
}

/** The gateway's empty provider pool is a structured 503 with no attempts. */
function isNoProviderError(err: unknown): boolean {
  return isRecord(err) && err.status === 503 && Array.isArray(err.attempts) && err.attempts.length === 0;
}

/**
 * Extract the test code from a model reply: the first ```javascript fence
 * when present, otherwise the raw reply (vendor behavior — the run then
 * fails honestly if the text is not code). Always trimmed.
 */
export function extractTestCode(raw: string): string {
  const match = raw.match(CODE_BLOCK_RE);
  return (match ? match[1] : raw).trim();
}

/** Deterministic test path beside the target (vendor naming). */
export function testPathFor(filePath: string, functionName: string): string {
  return path.posix.join(
    path.posix.dirname(filePath),
    `temp_${functionName.toLowerCase()}_test.mjs`,
  );
}

function buildPrompt(filePath: string, functionName: string, sliceContent: string): string {
  return [
    `TARGET FILE: ${filePath}`,
    `CODE SLICE:`,
    sliceContent,
    ``,
    `TASK: Write a standalone Node.js verification script in ES module (.mjs) format for '${functionName}'.`,
    `RULES:`,
    `1. Import the target function using relative import: import { ${functionName} } from './${path.posix.basename(filePath)}';`,
    `2. Use import assert from 'node:assert'; to test normal and edge cases.`,
    `3. Log 'TEST_PASSED' on completion.`,
    `4. Output ONLY valid JS code inside markdown \`\`\`javascript codeblock. No conversational text.`,
  ].join("\n");
}

function fail(testFilePath: string, output: string): TestGenResult {
  return { success: false, testFilePath, testPassed: false, output };
}

function lineBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

/**
 * Production exec binding: VmManager.exec streams stdout/stderr through
 * callbacks and returns only an exit code, so accumulate both streams
 * into the {stdout, stderr, exitCode} shape the pipeline consumes.
 */
export function vmExecFor(manager: VmManager = getVmManager()): AutoTestDeps["exec"] {
  return async (userId, cmd, opts) => {
    let stdout = "";
    let stderr = "";
    const result = await manager.exec(userId, cmd, {
      timeoutMs: opts?.timeoutMs,
      stdin: opts?.stdin,
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    return { stdout, stderr, exitCode: result.exitCode };
  };
}

/** Production deps: the shared VmManager + the real LLM gateway. */
export function autoTestDepsFor(manager: VmManager = getVmManager()): AutoTestDeps {
  return { exec: vmExecFor(manager), forward: forwardLlmNonStreaming };
}

/**
 * Generate and run a verification test for one function in the user's VM.
 * Never throws; see the file header for the result semantics.
 */
export async function generateAndRunVerificationTest(
  userId: string,
  deps: AutoTestDeps,
  target: AutoTestTarget,
): Promise<TestGenResult> {
  const forward = deps.forward ?? forwardLlmNonStreaming;

  if (!FUNCTION_NAME_RE.test(target.functionName)) {
    return fail("", `Invalid function name: ${JSON.stringify(target.functionName)}`);
  }

  let filePath: string;
  try {
    filePath = resolveWorkspacePath(target.filePath);
  } catch (err) {
    return fail("", errorMessage(err));
  }
  if (filePath === WORKSPACE_ROOT) {
    return fail("", `filePath must name a file inside ${WORKSPACE_ROOT}, not the workspace root.`);
  }
  const testFilePath = testPathFor(filePath, target.functionName);

  // Read the target out of the VM. The manager caps exec output (1 MiB by
  // default); source files beyond that are sliced from truncated content.
  let content: string;
  try {
    const read = await deps.exec(userId, ["cat", "--", filePath]);
    if (read.exitCode !== 0) {
      return fail(
        testFilePath,
        read.stderr.trim() || `Could not read ${filePath} (exit ${read.exitCode}).`,
      );
    }
    content = read.stdout;
  } catch (err) {
    return fail(testFilePath, errorMessage(err));
  }

  const slice = readSlice(
    { path: filePath, content },
    lineBound(target.startLine, DEFAULT_START_LINE),
    lineBound(target.endLine, DEFAULT_END_LINE),
  );

  // The slice goes to the user's own provider with the user's own key, but
  // a hardcoded secret in the function under test must still not leave the
  // VM unmasked (same posture as the git committer's diff redaction).
  const redact = makeRedactor();
  const prompt = buildPrompt(filePath, target.functionName, redact(slice.content));

  let raw: string;
  try {
    const completion = await forward({
      owner: userId,
      useRoutedModel: true,
      body: {
        system: "You are an automated unit test generator. Output raw javascript test code only.",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        stream: false,
      },
    });
    raw = completionText(completion.body);
  } catch (err) {
    return fail(testFilePath, isNoProviderError(err) ? NO_PROVIDER_OUTPUT : errorMessage(err));
  }

  const code = extractTestCode(raw);
  if (!code) return fail(testFilePath, "The model returned no test code.");

  // Write the test beside the target inside the VM (argv only; the code
  // travels on stdin, never through a shell string).
  try {
    const write = await deps.exec(userId, ["tee", "--", testFilePath], { stdin: `${code}\n` });
    if (write.exitCode !== 0) {
      return fail(
        testFilePath,
        write.stderr.trim() || `Could not write ${testFilePath} (exit ${write.exitCode}).`,
      );
    }
  } catch (err) {
    return fail(testFilePath, errorMessage(err));
  }

  // Run it inside the VM with a hard timeout. A non-zero exit (or a quota
  // throw) is a failed test, not a failed pipeline.
  try {
    const run = await deps.exec(userId, ["node", testFilePath], { timeoutMs: AUTO_TEST_TIMEOUT_MS });
    const passed = run.exitCode === 0 && run.stdout.includes("TEST_PASSED");
    const output = passed
      ? run.stdout.trim() || "All assertions passed."
      : [
          run.stdout.trim(),
          run.stderr.trim(),
          run.exitCode !== 0
            ? `Exited with code ${run.exitCode}.`
            : "Exited 0 without printing TEST_PASSED.",
        ]
          .filter(Boolean)
          .join("\n");
    return { success: true, testFilePath, testPassed: passed, output };
  } catch (err) {
    return { success: true, testFilePath, testPassed: false, output: errorMessage(err) };
  }
}
