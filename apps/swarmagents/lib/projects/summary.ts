/**
 * The "Previously…" context block injected into the first run of a new thread
 * in a project. It is a compact, bounded digest of the project's durable state
 * (open files, recent commands and exit codes, last test result, pinned notes,
 * active branch) so a fresh session picks up where the last one stopped.
 *
 * Budget: 3000 characters (~750 tokens, comfortably under the 800-token DoD
 * limit even with a pessimistic 3.5 chars/token estimate). The builder drops
 * the least important sections first and then hard-caps the result.
 */

import type { Project } from "./store";

export const PROJECT_CONTEXT_CHAR_BUDGET = 3000;

const SECTION_LIMITS = {
  files: 10,
  commands: 8,
  notes: 5,
  failing: 3,
} as const;

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statusLine(project: Project): string {
  const bits = [`project "${oneLine(project.name, 80)}"`];
  if (project.repo) bits.push(`repo ${oneLine(project.repo, 120)}`);
  if (project.activeBranch) bits.push(`branch ${oneLine(project.activeBranch, 80)}`);
  bits.push(`workspace ${oneLine(project.workspacePath, 120)}`);
  return `Previously… (${bits.join(" · ")})`;
}

/**
 * Build the context block. Always starts with "Previously…" so the agent (and
 * anyone reading the run log) can tell it is recovered context, not a user ask.
 */
export function buildProjectContext(project: Project): string {
  const lines: string[] = [statusLine(project)];

  const files = project.openFiles.slice(-SECTION_LIMITS.files);
  if (files.length > 0) {
    lines.push(`Open files: ${files.map((file) => oneLine(file, 160)).join(", ")}`);
  }

  const commands = project.commands.slice(-SECTION_LIMITS.commands);
  if (commands.length > 0) {
    lines.push("Recent commands (oldest first):");
    for (const entry of commands) {
      lines.push(`- \`${oneLine(entry.command, 180)}\` → exit ${entry.exitCode}`);
    }
  }

  if (project.lastTest) {
    const test = project.lastTest;
    const counts = [
      test.passed !== undefined ? `${test.passed} passed` : undefined,
      test.failed !== undefined ? `${test.failed} failed` : undefined,
    ].filter(Boolean);
    const verdict = test.ok ? "passing" : "failing";
    lines.push(
      `Last tests: \`${oneLine(test.command, 180)}\` → ${verdict} (exit ${test.exitCode}${counts.length ? `, ${counts.join(", ")}` : ""})`,
    );
    for (const failure of test.failing.slice(0, SECTION_LIMITS.failing)) {
      lines.push(`- failing: ${oneLine(failure, 180)}`);
    }
  }

  const notes = project.pinnedNotes.slice(-SECTION_LIMITS.notes);
  if (notes.length > 0) {
    lines.push("Pinned notes:");
    for (const note of notes) lines.push(`- ${oneLine(note, 220)}`);
  }

  lines.push("Continue this project from here. Re-read files before editing, and re-run the last failing test first if one is listed.");

  const joined = lines.join("\n");
  if (joined.length <= PROJECT_CONTEXT_CHAR_BUDGET) return joined;
  return `${joined.slice(0, PROJECT_CONTEXT_CHAR_BUDGET - 1).trimEnd()}…`;
}

/** Rough token estimate for the DoD budget (4 chars per token). */
export function estimateProjectContextTokens(context: string): number {
  return Math.ceil(context.length / 4);
}
