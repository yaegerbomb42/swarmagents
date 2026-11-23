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
import { makeRedactor } from "../harness/redact";
import type { HandbackSummary } from "../desktop-proxy/takeover/types";

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
  /**
   * Handback summary from the takeover session manager (what the human
   * did while driving: windows, modified files, input counts). Its text
   * is pattern-redacted before inclusion and truncated to whatever room
   * the 1,200-char budget leaves after the fixed framing lines.
   */
  takeoverSummary?: HandbackSummary | null;
}

function shotDescriptor(shot: CapturedShot): string {
  const kb = Math.round(shot.bytes.length / 1024);
  return `A screenshot of the current on-screen state was captured (${shot.mime}, ${kb} KB).`;
}

/** Build a compact, credential-free context summary for the resuming agent. */
export function buildHandoffSummary(input: HandoffSummaryInput): string {
  const elapsedMs = Math.max(0, input.resolvedAt - input.startedAt);
  const elapsedSec = Math.round(elapsedMs / 1000);
  const head: string[] = [
    "The user handed the desktop back to you.",
    `The desktop was with the user for ~${elapsedSec}s.`,
  ];
  const tail: string[] = [];
  if (input.shot) {
    tail.push(shotDescriptor(input.shot));
  } else {
    tail.push("A post-handoff screenshot could not be captured; re-check the on-screen state yourself.");
  }
  if (input.description && input.description.trim()) {
    const brief = input.description.trim().slice(0, 300);
    tail.push(`The agent noted: "${brief}".`);
  }
  tail.push("Continue the task from the current on-screen state. Session cookies in the VM remain alive; the desktop is back under your control.");

  // The takeover summary is the only variable-length part. Redact it
  // (pattern-based: window titles and file names can carry key-shaped
  // strings) and fit it into the budget the framing leaves, truncating
  // with an ellipsis rather than letting the final slice amputate the
  // closing instructions.
  const takeoverText = input.takeoverSummary?.text?.trim()
    ? makeRedactor()(input.takeoverSummary.text.trim())
    : "";
  const parts = [...head];
  if (takeoverText) {
    const fixedLen = [...head, ...tail].join(" ").length;
    const room = HANDOFF_SUMMARY_MAX_CHARS - fixedLen - 1; // 1 for the join space
    if (room >= 40) {
      const fitted =
        takeoverText.length <= room ? takeoverText : `${takeoverText.slice(0, room - 1)}…`;
      parts.push(fitted);
    }
  }
  parts.push(...tail);
  return parts.join(" ").slice(0, HANDOFF_SUMMARY_MAX_CHARS);
}
