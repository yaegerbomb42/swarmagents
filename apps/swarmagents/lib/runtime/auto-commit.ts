/**
 * Post-run auto-commit gate (run-flow wiring for the git smart committer).
 *
 * After a successful agent run, when the account opted in via the
 * `gitAutoCommit` user setting (default off), the run's tracked workspace
 * changes are committed with an LLM-written message (see
 * `lib/harness/git-committer.ts`). The result is published as a
 * `git.commit` run event so it lands in the run log, the SSE stream, the
 * trajectory, and the run report.
 *
 * Best-effort by contract: this never throws and never blocks or fails the
 * finished run. A commit failure — including a VM image without a git
 * identity (`user.name`/`user.email`), whose error surfaces verbatim in
 * `output` — is published as the event's failure payload and the run
 * finalizes normally. No author identity is invented here; a missing one
 * is an image-level fix.
 */

import type { GitCommitResult } from "../harness/git-committer";
import { gitAutoCommitEnabled, readUserSettings, type UserSettings } from "../providers/settings";

export interface AutoCommitDeps {
  /** Commit the user's tracked workspace changes (never throws). */
  commit: (userId: string) => Promise<GitCommitResult>;
  /** Publish one event onto the run's telemetry bus. */
  publish: (runId: string, event: { type: string; data?: unknown }) => void;
  /** Settings source; defaults to the per-user settings file. */
  settingsFor?: (userId: string) => UserSettings;
}

export interface AutoCommitInput {
  userId: string;
  runId: string;
  /** The finished run's exit code; only 0 counts as a successful run. */
  exitCode: number;
}

/**
 * Attempt the post-run auto-commit for one finished run.
 *
 * Returns true when an attempt ran (setting enabled and exit code 0) —
 * including a failed attempt, whose outcome is published either way.
 * Returns false when the gate is closed (disabled setting, non-zero exit,
 * or unreadable settings), in which case nothing is published and the
 * caller's finalize path is byte-identical to a run without this feature.
 */
export async function maybeAutoCommitAfterRun(
  deps: AutoCommitDeps,
  input: AutoCommitInput,
): Promise<boolean> {
  try {
    if (input.exitCode !== 0) return false;
    const settings = (deps.settingsFor ?? readUserSettings)(input.userId);
    if (!gitAutoCommitEnabled(settings)) return false;

    let result: GitCommitResult;
    try {
      result = await deps.commit(input.userId);
    } catch (err) {
      // `smartCommit` never throws by contract; this guards injected deps
      // (and any future committer) so a defect there still cannot fail
      // the finished run.
      result = {
        success: false,
        commitMessage: "",
        filesCommitted: [],
        output: err instanceof Error ? err.message : "Auto-commit failed.",
      };
    }

    deps.publish(input.runId, {
      type: "git.commit",
      data: {
        success: result.success,
        commitMessage: result.commitMessage,
        filesCommitted: result.filesCommitted,
        output: result.output,
      },
    });
    return true;
  } catch {
    // Telemetry/settings plumbing must never break run finalization.
    return false;
  }
}
