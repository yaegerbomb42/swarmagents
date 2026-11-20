/**
 * Store for the shadow-verifier result that survived a run, mirroring the
 * auto-audit store (lib/lenses/audit.ts). The report route reads it and the UI
 * surfaces the badge on the run's report card.
 */

import fs from "node:fs";
import path from "node:path";
import { getRunsDir } from "../telemetry/paths";
import { reportDir } from "../runtime/run-report";
import type { RunVerificationMeta } from "../runtime/run-report-types";

/** Where the verification document lives, next to the run's report. */
export function verificationFilePath(runsDir: string, runId: string): string {
  return path.join(reportDir(runsDir, runId), "verification.json");
}

/** Read a stored verification meta, or null when none exists yet. */
export function readRunVerification(
  runId: string,
  runsDir: string | null = getRunsDir(),
): RunVerificationMeta | null {
  if (!runsDir) return null;
  try {
    const text = fs.readFileSync(verificationFilePath(runsDir, runId), "utf8");
    const parsed = JSON.parse(text) as RunVerificationMeta;
    if (parsed && typeof parsed.badge === "string" && typeof parsed.score === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Persist the verification meta for a run. Never throws into the caller. */
export function writeRunVerification(
  runId: string,
  meta: RunVerificationMeta,
  runsDir: string | null = getRunsDir(),
): void {
  if (!runsDir) return;
  try {
    fs.mkdirSync(reportDir(runsDir, runId), { recursive: true });
    fs.writeFileSync(verificationFilePath(runsDir, runId), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // The report still stands on its own; a missing badge is not fatal.
  }
}
