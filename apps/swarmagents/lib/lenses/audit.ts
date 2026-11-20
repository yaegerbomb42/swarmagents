/**
 * Auto-lens pipelines: when a role has a lens pinned to it (e.g. Coder →
 * security), the runtime audits the run's artifact diff with that lens as soon
 * as the run finishes and attaches a pass/warn verdict to the run.
 *
 * The audit reuses the same lens machinery as POST /api/lenses (runLens on the
 * cheapest capable model) but runs server-side in the background rather than on
 * a user request, and writes its result to `<runsDir>/reports/<runId>/` next to
 * the run report so the UI can surface a badge before the user reads the run.
 */

import fs from "node:fs";
import path from "node:path";
import { getRunsDir } from "../telemetry/paths";
import { reportDir, readRunReport } from "../runtime/run-report";
import type { AuditVerdict, RunAudit, RunReport } from "../runtime/run-report-types";
import { userRoleCatalog } from "../roles-store";
import { getVmManager } from "../vm/manager";
import { looksBinary, resolveWorkspacePath, VmPathError } from "../vm/files";
import { runLens } from "./run";
import { isLensId, type LensId } from "./types";
import {
  MAX_FILES,
  MAX_FILE_CHARS,
  capText,
  type ReferencedFile,
} from "./prompts";

/** Bytes read from one referenced file in the VM for an audit. */
const MAX_AUDIT_FILE_BYTES = 32 * 1024;
/** Cap on artifact lines described in the audit message. */
const MAX_SUMMARY_ARTIFACTS = 10;
/** Cap on the agent's final message quoted into the audit message. */
const MAX_SUMMARY_FINAL_TEXT = 3000;

/** Severity-tagged finding lines produced by the review-style lenses. */
const FINDING_RE = /-\s*\[(critical|high|medium|low|blocker|major|minor)\]/i;

/**
 * The lens pinned to a role, if any. Resolves through the user's catalog (a
 * custom role may add a pin); the built-in Implementer (Coder) role ships with
 * lens "security" as the default seed.
 */
export function pinnedLensForRole(userId: string, roleId: string | undefined): LensId | undefined {
  if (!roleId) return undefined;
  const role = userRoleCatalog(userId).find((candidate) => candidate.id === roleId);
  return role && isLensId(role.lens) ? role.lens : undefined;
}

/**
 * Classify a lens answer into a pass/warn verdict. Any severity-tagged finding
 * line (e.g. `- [high] ...`) means warn; a clean answer ("No issues found")
 * passes.
 */
export function classifyLensFindings(text: string): AuditVerdict {
  return FINDING_RE.test(text) ? "warn" : "pass";
}

/** Where the audit document lives, next to the run's report. */
export function auditFilePath(runsDir: string, runId: string): string {
  return path.join(reportDir(runsDir, runId), "audit.json");
}

/** Read a stored audit, or null when none exists yet. */
export function readRunAudit(runId: string, runsDir: string | null = getRunsDir()): RunAudit | null {
  if (!runsDir) return null;
  try {
    const text = fs.readFileSync(auditFilePath(runsDir, runId), "utf8");
    return JSON.parse(text) as RunAudit;
  } catch {
    return null;
  }
}

function writeRunAudit(runId: string, audit: RunAudit, runsDir: string): void {
  try {
    fs.mkdirSync(reportDir(runsDir, runId), { recursive: true });
    fs.writeFileSync(auditFilePath(runsDir, runId), JSON.stringify(audit, null, 2), "utf8");
  } catch (error) {
    console.error(`[auto-lens] could not write audit for ${runId}:`, error);
  }
}

/**
 * The files the run created/modified, read from the user's VM. Best effort: a
 * hibernated VM or a missing file simply means less context.
 */
export async function collectRunArtifactFiles(userId: string, runId: string): Promise<ReferencedFile[]> {
  const report = readRunReport(runId);
  if (!report || report.artifacts.length === 0) return [];
  const vm = getVmManager();
  const files: ReferencedFile[] = [];
  for (const artifact of report.artifacts) {
    if (files.length >= MAX_FILES) break;
    if (artifact.size > MAX_AUDIT_FILE_BYTES) continue;
    try {
      const abs = resolveWorkspacePath(artifact.rel);
      const bytes = await vm.readFileBytes(userId, abs, MAX_AUDIT_FILE_BYTES);
      if (looksBinary(bytes.content)) continue;
      const content = Buffer.from(bytes.content).toString("utf-8");
      if (!content.trim()) continue;
      files.push({ path: artifact.rel, content: content.slice(0, MAX_FILE_CHARS) });
    } catch (err) {
      if (err instanceof VmPathError) continue;
      /* the file is gone or the VM is asleep — continue without it */
    }
  }
  return files;
}

function buildAuditMessage(report: RunReport): string {
  const parts: string[] = [`Auto-audit of run ${report.runId} (${report.status}).`];
  if (report.finalText) {
    parts.push(`Agent's final message:\n${capText(report.finalText, MAX_SUMMARY_FINAL_TEXT)}`);
  }
  if (report.artifacts.length > 0) {
    const lines = report.artifacts
      .slice(0, MAX_SUMMARY_ARTIFACTS)
      .map((artifact) => `- ${artifact.change} ${artifact.rel}`);
    if (report.artifacts.length > MAX_SUMMARY_ARTIFACTS) {
      lines.push(`- …and ${report.artifacts.length - MAX_SUMMARY_ARTIFACTS} more files`);
    }
    parts.push(`Files changed:\n${lines.join("\n")}`);
  } else {
    parts.push("No files were created or modified.");
  }
  return parts.join("\n\n");
}

/**
 * Run the pinned lens over a finished run's report and persist the verdict.
 * No-op when an audit already exists for the run. Never throws into the caller:
 * failures are logged and swallowed (the report still stands on its own).
 */
export async function runAutoAudit(input: {
  userId: string;
  runId: string;
  lens: LensId;
  runsDir?: string | null;
}): Promise<RunAudit | null> {
  const runsDir = input.runsDir ?? getRunsDir();
  if (!runsDir) return null;
  const existing = readRunAudit(input.runId, runsDir);
  if (existing) return existing;

  const report = readRunReport(input.runId, runsDir);
  if (!report) return null;

  try {
    const message = buildAuditMessage(report);
    const files = await collectRunArtifactFiles(input.userId, input.runId);
    const result = await runLens({
      userId: input.userId,
      lens: input.lens,
      message,
      files,
      runId: input.runId,
    });
    const audit: RunAudit = {
      lens: input.lens,
      verdict: classifyLensFindings(result.text),
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd ?? undefined,
      latencyMs: result.latencyMs,
      cached: result.cached,
      text: result.text,
      createdAt: Date.now(),
    };
    writeRunAudit(input.runId, audit, runsDir);
    return audit;
  } catch (error) {
    console.error(`[auto-lens] audit failed for ${input.runId}:`, error);
    return null;
  }
}
