/**
 * Host-side git smart committer (port of vendor/claude-code-mini
 * `gitSmartCommitter.ts`, task #32).
 *
 * One call stages tracked changes in the user's VM workspace, reads the
 * staged diff, asks the user's own provider for a one-line
 * conventional-commit message, and commits — so runs leave clean,
 * well-described commits instead of a dirty tree.
 *
 * Deliberate differences from the vendor original:
 *   - git runs inside the user's VM via `VmManager.exec` with argv arrays
 *     (the vendor interpolated the message into a shell string);
 *   - the LLM call goes through `forwardLlmNonStreaming` with the run
 *     owner's per-user providers (the vendor's GroqClient/keypool does not
 *     come along — keys stay per-user BYOK);
 *   - the diff is scrubbed with the harness redactor before prompting, so a
 *     secret-shaped string in the change never reaches the provider;
 *   - every git step's exit code is checked, and the function never throws —
 *     failures return `{ success: false, output }`.
 */

import { forwardLlmNonStreaming } from "../runtime/llm-gateway";
import { WORKSPACE_ROOT } from "../vm/files";
import { getVmManager, type VmManager } from "../vm/manager";
import { makeRedactor } from "./redact";

export interface GitCommitResult {
  success: boolean;
  commitMessage: string;
  filesCommitted: string[];
  output: string;
}

/** Result of one argv-array git invocation inside the VM. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SmartCommitDeps {
  exec: (userId: string, cmd: string[]) => Promise<GitExecResult>;
  forward?: typeof forwardLlmNonStreaming;
}

export interface SmartCommitOptions {
  /** Stage tracked changes (`git add -u`) before reading the diff. Default true. */
  autoStageAll?: boolean;
  /** Max diff characters sent to the model. Default {@link DEFAULT_MAX_DIFF_CHARS}. */
  maxDiffChars?: number;
}

export const DEFAULT_MAX_DIFF_CHARS = 3000;
/** Per-git-command timeout applied by the production VmManager binding. */
export const GIT_EXEC_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_CHARS = 2000;
const SYSTEM_PROMPT =
  "You are an automated git commit assistant. Output only a 1-line conventional commit message.";
const redactDiff = makeRedactor();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plain-text content of an Anthropic-shaped completion body. Copied from
 * `lib/board-agent/agent.ts` (not exported there): string bodies pass
 * through, otherwise the text blocks are concatenated.
 */
function completionText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!isRecord(body) || !Array.isArray(body.content)) return "";
  return body.content
    .map((block: unknown) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

function failure(output: string): GitCommitResult {
  return { success: false, commitMessage: "", filesCommitted: [], output };
}

/** The most useful stream of a failed git call, bounded for display. */
function outputOf(result: GitExecResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text.slice(0, MAX_OUTPUT_CHARS);
}

function normalizeMaxDiffChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_DIFF_CHARS;
  }
  return Math.min(Math.floor(value), 100_000);
}

/**
 * The model's reply reduced to a commit subject: first non-empty line, with
 * any surrounding quotes the model added despite instructions stripped.
 */
function cleanCommitMessage(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.replace(/^["']|["']$/g, "").trim();
}

/** A caller-readable reason for a failed gateway forward. */
function llmFailureMessage(err: unknown): string {
  if (isRecord(err) && typeof err.status === "number") {
    // The gateway's empty provider pool is a structured 503 with no attempts.
    if (err.status === 503 && Array.isArray(err.attempts) && err.attempts.length === 0) {
      return "No LLM provider is configured for this account. Add your key in Settings (BYOK) before committing.";
    }
    return `Could not generate a commit message: the provider request failed (status ${err.status}).`;
  }
  const message = err instanceof Error ? err.message : "";
  return message
    ? `Could not generate a commit message: ${message}`
    : "Could not generate a commit message.";
}

function parseFileList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Files touched by HEAD. `HEAD~1` does not exist on a root commit, so fall
 * back to `git show`. A listing failure never fails the commit itself — the
 * commit already landed; the file list is metadata.
 */
async function listCommittedFiles(
  exec: SmartCommitDeps["exec"],
  userId: string,
): Promise<string[]> {
  const diff = await exec(userId, ["git", "diff", "--name-only", "HEAD~1"]);
  if (diff.exitCode === 0) return parseFileList(diff.stdout);
  const show = await exec(userId, ["git", "show", "--pretty=format:", "--name-only", "HEAD"]);
  return show.exitCode === 0 ? parseFileList(show.stdout) : [];
}

/**
 * Stage (optionally), describe, and commit the workspace's tracked changes.
 * Never throws: every failure path returns `{ success: false, output }` and
 * commits nothing.
 */
export async function smartCommit(
  userId: string,
  deps: SmartCommitDeps,
  options: SmartCommitOptions = {},
): Promise<GitCommitResult> {
  const autoStageAll = options.autoStageAll ?? true;
  const maxDiffChars = normalizeMaxDiffChars(options.maxDiffChars);
  const forward = deps.forward ?? forwardLlmNonStreaming;

  try {
    if (autoStageAll) {
      const added = await deps.exec(userId, ["git", "add", "-u"]);
      if (added.exitCode !== 0) return failure(`git add -u failed: ${outputOf(added)}`);
    }

    const diffResult = await deps.exec(userId, ["git", "diff", "--cached"]);
    if (diffResult.exitCode !== 0) {
      return failure(`git diff --cached failed: ${outputOf(diffResult)}`);
    }
    const diff = diffResult.stdout.trim();
    if (!diff) return failure("No staged changes to commit.");

    // Slice to protect the token budget, then scrub secret-shaped strings so
    // a key pasted into the change never reaches the provider.
    const slicedDiff = redactDiff(diff.slice(0, maxDiffChars));
    const prompt = [
      "TASK: Generate a concise, conventional git commit message based on this diff.",
      "FORMAT: <type>(<scope>): <short description>",
      "EXAMPLES:",
      "- fix(auth): correct token expiration check and handle missing bearer token",
      "- refactor(keypool): add rotating cooldown tracking for groq multi-pool",
      "RULES: Output ONLY the 1-line commit message. No quotes, no markdown, no explanation.",
      "",
      "DIFF:",
      slicedDiff,
    ].join("\n");

    let commitMessage: string;
    try {
      const completion = await forward({
        owner: userId,
        useRoutedModel: true,
        body: {
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 50,
          temperature: 0.1,
          stream: false,
        },
      });
      commitMessage = cleanCommitMessage(completionText(completion.body));
    } catch (err) {
      return failure(llmFailureMessage(err));
    }
    if (!commitMessage) return failure("The model returned an empty commit message.");

    const committed = await deps.exec(userId, ["git", "commit", "-m", commitMessage]);
    if (committed.exitCode !== 0) {
      return failure(`git commit failed: ${outputOf(committed)}`);
    }

    const filesCommitted = await listCommittedFiles(deps.exec, userId);
    return {
      success: true,
      commitMessage,
      filesCommitted,
      output: committed.stdout.trim().slice(0, MAX_OUTPUT_CHARS),
    };
  } catch (err) {
    return failure(err instanceof Error ? err.message : "Smart commit failed.");
  }
}

/**
 * Bind a VmManager to the committer's `exec` dep: argv arrays only, run in
 * the workspace root, stdout/stderr accumulated from the manager's stream
 * callbacks (its `ExecResult` carries only the exit code).
 */
export function vmExecFor(
  manager: VmManager,
  options: { timeoutMs?: number } = {},
): SmartCommitDeps["exec"] {
  const timeoutMs = options.timeoutMs ?? GIT_EXEC_TIMEOUT_MS;
  return async (userId, cmd) => {
    let stdout = "";
    let stderr = "";
    const result = await manager.exec(userId, cmd, {
      cwd: WORKSPACE_ROOT,
      timeoutMs,
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

/** Production deps: the shared VmManager plus the LLM gateway. */
export function smartCommitDepsFor(manager: VmManager = getVmManager()): SmartCommitDeps {
  return { exec: vmExecFor(manager), forward: forwardLlmNonStreaming };
}
