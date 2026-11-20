/**
 * Compact post-handoff state summary returned to the resuming agent as the
 * ask_human_desktop tool result.
 *
 * The summary is intentionally concise and text-only: session cookies never
 * leave the VM and the summary carries no credentials — it tells the agent
 * what happened, how long the wheel was with the human, and that a screenshot
 * of the current on-screen state was captured (so it can visually re-orient
 * if the desktop tooling exposes it).
 */

import type { CapturedShot } from "./run-report";

export const HANDOFF_SUMMARY_MAX_CHARS = 1200;

export interface HandoffSummaryInput {
  /** Epoch ms when the handoff was requested. */
  startedAt: number;
  /** Epoch ms when the user handed the desktop back. */
  resolvedAt: number;
  /** Post-handoff screenshot capture (raw PNG bytes), if one succeeded. */
  shot?: CapturedShot | null;
  /** Optional free-text detail the agent gave in the tool call. */
  description?: string;
}

function shotDescriptor(shot: CapturedShot): string {
  const kb = Math.round(shot.bytes.length / 1024);
  return `A screenshot of the current on-screen state was captured (${shot.mime}, ${kb} KB).`;
}

/** Build a compact, credential-free context summary for the resuming agent. */
export function buildHandoffSummary(input: HandoffSummaryInput): string {
  const elapsedMs = Math.max(0, input.resolvedAt - input.startedAt);
  const elapsedSec = Math.round(elapsedMs / 1000);
  const parts: string[] = [
    "The user handed the desktop back to you.",
    `The desktop was with the user for ~${elapsedSec}s.`,
  ];
  if (input.shot) {
    parts.push(shotDescriptor(input.shot));
  } else {
    parts.push("A post-handoff screenshot could not be captured; re-check the on-screen state yourself.");
  }
  if (input.description && input.description.trim()) {
    const brief = input.description.trim().slice(0, 300);
    parts.push(`The agent noted: "${brief}".`);
  }
  parts.push("Continue the task from the current on-screen state. Session cookies in the VM remain alive; the desktop is back under your control.");
  return parts.join(" ").slice(0, HANDOFF_SUMMARY_MAX_CHARS);
}
