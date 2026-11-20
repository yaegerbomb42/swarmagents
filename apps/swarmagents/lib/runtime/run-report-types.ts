/**
 * Shared types for the per-run "Run report" — a verifiable receipt created
 * automatically when a run finishes. Kept dependency-free (no node imports)
 * so the server modules (lib/runtime/run-report.ts) and the browser UI
 * (minimalist-ui) can both import it.
 */

/** Terminal status of a run the report was built for. */
export type ReportStatus = "finished" | "error" | "cancelled";

/** One condensed, human-readable step in the run's timeline. */
export interface ReportStep {
  /** First telemetry seq contributing to this step (stable ordering key). */
  seq: number;
  /** Epoch ms of the step. */
  ts: number;
  kind: "start" | "message" | "tool" | "desktop" | "approval" | "blocked" | "notice" | "end";
  /** Short display line (e.g. "Using Bash" or "Clicking Sign in"). */
  text: string;
  /** Optional supporting detail (tool input summary, error text). */
  detail?: string;
  /** Outcome, when the step is a tool call with a result. */
  ok?: boolean;
  /** Index into `shots` when this step has an accompanying screenshot. */
  shot?: number;
}

/** One stored screenshot in the run report. */
export interface ReportShotMeta {
  /** File name inside the run's shots directory (e.g. "000.png"). */
  file: string;
  /** MIME type of the stored image. */
  mime: string;
  /** Telemetry seq that triggered the shot (0 = run start, Infinity = end). */
  seq: number;
  /** Epoch ms when the shot was taken. */
  ts: number;
  /** Short label ("Start", "End", or the action text). */
  label: string;
  /** Byte size of the stored image. */
  size: number;
}

/** A file the agent created or modified under /workspace during the run. */
export interface ReportArtifact {
  /** Absolute path inside the VM. */
  path: string;
  /** Path relative to /workspace (also the download `?path=` value). */
  rel: string;
  /** Size in bytes at run end. */
  size: number;
  /** Last modification time in epoch ms at run end. */
  mtimeMs: number;
  /** Whether the file did not exist at run start. */
  change: "created" | "modified";
}

/** Compact summary shown on the report card without fetching the full report. */
export interface ReportCardMeta {
  status: ReportStatus;
  /** Number of condensed timeline steps. */
  steps: number;
  /** Number of stored screenshots. */
  shots: number;
  /** Number of artifacts created/modified under /workspace. */
  artifacts: number;
  durationMs?: number;
  costUsd?: number;
  /** Provider ids used by the run (empty for legacy host-env runs). */
  providers: string[];
  model?: string;
  /**
   * VM image the run executed in (the driver's configured image, e.g.
   * "swarm-vm:claude"). The proof bundle asserts this instead of assuming
   * the default image. Undefined for drivers without an image (fake runs)
   * and for reports written before this field existed.
   */
  vmImage?: string;
  /** Shadow-verifier gate result, when one ran for the run. */
  verification?: RunVerificationMeta;
}

/** The shadow-verifier gate result for a run. */
export interface RunVerificationMeta {
  badge: "pass" | "warn" | "fail";
  /** 0 - 100 verifier score. */
  score: number;
  /** Number of verification rounds (primary-agent attempts) used. */
  roundsUsed: number;
  violations: string[];
  passed: boolean;
}

/** Verdict of an auto-audit of a run's artifacts. */
export type AuditVerdict = "pass" | "warn";

/**
 * The result of a lens pinned to the run's role (e.g. a security lens on the
 * Coder role). Written server-side after the report exists and surfaced by the
 * report route alongside the report itself.
 */
export interface RunAudit {
  /** The lens that ran (e.g. "security"). */
  lens: string;
  verdict: AuditVerdict;
  /** Provider/model that served the audit call (cheapest capable). */
  provider?: string;
  model?: string;
  costUsd?: number;
  latencyMs?: number;
  /** True when the answer came from the lens cache (no provider call). */
  cached: boolean;
  /** The lens's full answer (the findings the verdict was derived from). */
  text: string;
  /** Epoch ms the audit was produced. */
  createdAt: number;
}

/** The full per-run report document. */
export interface RunReport {
  runId: string;
  userId: string;
  status: ReportStatus;
  prompt: string;
  /** Epoch ms the run was created. */
  createdAt: number;
  /** Epoch ms the run reached its terminal state. */
  finishedAt: number;
  /** The agent's final message (last assistant text), when present. */
  finalText?: string;
  /** Explicit "What I could not do" section derived from failed steps. */
  couldNotDo: string[];
  /** Condensed timeline of the run's tool/computer.action events. */
  steps: ReportStep[];
  /** Files created/modified under /workspace during the run. */
  artifacts: ReportArtifact[];
  /** Screenshots taken at start, during, and at end of the run. */
  shots: ReportShotMeta[];
  meta: ReportCardMeta;
  /**
   * Auto-audit verdict from the run's role-pinned lens, when one has landed
   * (stored separately and merged into the report by the serving route).
   */
  audit?: RunAudit;
  /**
   * Shadow-verifier gate result, when one ran (stored separately and merged
   * into the report by the serving route).
   */
  verification?: RunVerificationMeta;
}
