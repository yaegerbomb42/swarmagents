/**
 * Project state recorder.
 *
 * The runtime forwards every harness telemetry event for a run that belongs to
 * a project through `noteProjectRunEvent`. From those events we derive the
 * durable state a new thread needs:
 *
 *  - open files      (Read / Write / Edit / MultiEdit / NotebookEdit calls)
 *  - commands        (Bash calls, joined with their tool result for exit code)
 *  - last test       (test-runner commands: vitest/jest/node:test/pytest/go/cargo)
 *  - active branch   (`git checkout -b`, `git switch -c`, `git switch`, `git branch -m`)
 *  - threads         (the harness sessionId, attached when run.started arrives)
 *
 * Everything is best-effort: a malformed event, a deleted project, or an
 * unwritable store must never break a user's run. No secrets are read or
 * stored — command text is already redacted by the harness before we see it.
 */

import { attachThread, mutateProject, MAX_COMMANDS, type ProjectTestResult } from "./store";

interface RecorderEvent {
  type: string;
  name?: string;
  input?: unknown;
  id?: string;
  ok?: boolean;
  output?: string;
  sessionId?: string;
}

interface PendingCommand {
  command: string;
  at: number;
}

/** Commands whose tool.result has not arrived yet, keyed by runId + tool id. */
const pending = new Map<string, PendingCommand>();

/** Test hook: drop in-flight command tracking between tests. */
export function resetProjectRecorder(): void {
  pending.clear();
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "str_replace_editor"]);

const TEST_COMMAND_RE =
  /(^|[\s;&|])(npm (run )?test|pnpm (run )?test|yarn (run )?test|npx (vitest|jest)|vitest|jest|pytest|python3? -m pytest|go test|cargo test|make test)(\s|$)/;

/** True when a shell command runs a test suite we know how to summarize. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_RE.test(command);
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function cleanOutput(output: string): string {
  return output.replace(ANSI_RE, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return undefined;
}

function commandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input.command;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

/** Best-effort branch switch detection from a shell command. */
export function branchFromCommand(command: string): string | undefined {
  const clean = command.trim();
  let match = clean.match(/\bgit\s+branch\s+-[mM]\s+([A-Za-z0-9._/-]+)/);
  if (!match) match = clean.match(/\bgit\s+(?:checkout|switch)\s+(?:-[bBcC]\s+)?([A-Za-z0-9._/-]+)/);
  const branch = match?.[1];
  if (!branch || branch.startsWith("-") || branch === "HEAD") return undefined;
  // `git checkout -- file` and `git checkout path/to/file` are file restores,
  // not branch switches. Branch names essentially never contain a dot suffix.
  if (branch.includes(".")) return undefined;
  return branch.slice(0, 200);
}

interface ParsedTests {
  passed?: number;
  failed?: number;
  failing: string[];
}

/** Parse the common test-runner output shapes for counts and failing names. */
export function parseTestOutput(output: string): ParsedTests {
  const clean = cleanOutput(output);
  let passed: number | undefined;
  let failed: number | undefined;

  const passedMatch = clean.match(/(\d+)\s+passed\b/i);
  if (passedMatch) passed = Number(passedMatch[1]);
  const failedMatch = clean.match(/(\d+)\s+failed\b/i);
  if (failedMatch) failed = Number(failedMatch[1]);

  // node:test summary uses "# pass 5" / "# fail 1".
  const nodePass = clean.match(/^\s*#\s*pass\s+(\d+)\s*$/im);
  if (nodePass) passed = Number(nodePass[1]);
  const nodeFail = clean.match(/^\s*#\s*fail\s+(\d+)\s*$/im);
  if (nodeFail) failed = Number(nodeFail[1]);

  // Jest: "Tests: 1 failed, 24 passed, 25 total".
  const jest = clean.match(/Tests:\s*([^\n]+)/);
  if (jest) {
    const jestFailed = jest[1].match(/(\d+)\s+failed/);
    const jestPassed = jest[1].match(/(\d+)\s+passed/);
    if (jestFailed) failed = Number(jestFailed[1]);
    if (jestPassed) passed = Number(jestPassed[1]);
  }

  const failing: string[] = [];
  const seen = new Set<string>();
  for (const line of clean.split(/\r?\n/)) {
    if (!/^\s*(FAIL\b|✗|×|●|not ok\b|FAILED\b)/.test(line)) continue;
    const item = line.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    failing.push(item);
    if (failing.length >= 3) break;
  }

  return { passed, failed, failing };
}

function exitCodeFromResult(event: RecorderEvent): number {
  const output = typeof event.output === "string" ? cleanOutput(event.output) : "";
  const explicit = output.match(/\bexit\s+code:?\s*(-?\d+)/i);
  if (explicit) {
    const code = Number(explicit[1]);
    if (Number.isFinite(code)) return Math.max(-1, Math.min(255, code));
  }
  return event.ok === false ? 1 : 0;
}

function recordCommand(
  userId: string,
  projectId: string,
  runId: string,
  pendingCommand: PendingCommand,
  event: RecorderEvent,
): void {
  const exitCode = exitCodeFromResult(event);
  const isTest = isTestCommand(pendingCommand.command);
  const output = typeof event.output === "string" ? cleanOutput(event.output) : "";
  const parsed = isTest ? parseTestOutput(output) : { failing: [] };
  const branch = exitCode === 0 ? branchFromCommand(pendingCommand.command) : undefined;

  try {
    mutateProject(userId, projectId, (project) => {
      project.commands.push({
        command: pendingCommand.command,
        exitCode,
        at: pendingCommand.at,
        runId,
      });
      if (project.commands.length > MAX_COMMANDS) {
        project.commands.splice(0, project.commands.length - MAX_COMMANDS);
      }
      if (branch) project.activeBranch = branch;
      if (isTest) {
        const result: ProjectTestResult = {
          command: pendingCommand.command,
          ok: exitCode === 0,
          exitCode,
          ...(parsed.passed !== undefined ? { passed: parsed.passed } : {}),
          ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}),
          failing: parsed.failing,
          ...(output ? { outputTail: output.slice(-1000) } : {}),
          at: pendingCommand.at,
          runId,
        };
        project.lastTest = result;
      }
    });
  } catch {
    // Project deleted mid-run (or store unavailable): the run must continue.
  }
}

function recordOpenFile(userId: string, projectId: string, file: string): void {
  try {
    mutateProject(userId, projectId, (project) => {
      project.openFiles = project.openFiles.filter((entry) => entry !== file);
      project.openFiles.unshift(file);
      if (project.openFiles.length > 50) project.openFiles.length = 50;
    });
  } catch {
    // Best effort.
  }
}

/**
 * Fold one harness event into the project's durable state. Called by the
 * runtime for runs started with a project id; safe to call for any event.
 */
export function noteProjectRunEvent(
  userId: string,
  projectId: string,
  runId: string,
  event: RecorderEvent,
): void {
  if (!userId || !projectId) return;
  if (!event || typeof event.type !== "string") return;

  if (event.type === "tool.call") {
    const key = `${runId}:${event.id ?? event.name ?? "tool"}`;
    if (event.name === "Bash") {
      const command = commandFromInput(event.input);
      if (command) pending.set(key, { command, at: Date.now() });
      return;
    }
    if (FILE_TOOLS.has(event.name ?? "")) {
      const file = fileFromInput(event.input);
      if (file) recordOpenFile(userId, projectId, file);
    }
    return;
  }

  if (event.type === "tool.result") {
    const key = `${runId}:${event.id ?? "tool"}`;
    const command = pending.get(key);
    if (!command) return;
    pending.delete(key);
    recordCommand(userId, projectId, runId, command, event);
    return;
  }

  if (event.type === "run.started" || event.type === "run.finished") {
    if (event.sessionId) attachThread(userId, projectId, event.sessionId);
  }
}
