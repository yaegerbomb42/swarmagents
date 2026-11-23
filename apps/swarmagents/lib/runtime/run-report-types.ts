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

import type { RunReceipt } from "./run-receipt";

/** Token + cost totals for one provider/model pair within a run. */
export interface ModelTokenAccounting {
  provider: string;
  model: string;
  /** Gateway attempts (llm.call events), ok or not. */
  calls: number;
  /** Attempts that succeeded (outcome "ok"). */
  okCalls: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Sum of per-call costs (lib/providers/pricing.ts, stamped on each
   * llm.call at emit time). Provider-reported costs (usage.cost) are
   * preferred over estimates when present — see reportedCostCalls.
   * Undefined when no call reported a price — the UI shows "unknown",
   * never an invented number.
   */
  costUsd?: number;
  /** Calls whose price was unknown (costUsd null on the event). */
  unknownCostCalls: number;
  /** Priced calls whose costUsd is the provider-reported amount. */
  reportedCostCalls: number;
}

/**
 * Per-run token accounting, folded from the run's telemetry at report
 * time (see lib/telemetry/run-token-accounting.ts). `byModel`/`totals`
 * come from gateway llm.call events; `harness` is the CLI stream's own
 * usage accounting, present when the stream reported usage.
 */
export interface RunTokenAccounting {
  /** Per provider/model breakdown, busiest first. */
  byModel: ModelTokenAccounting[];
  totals: {
    calls: number;
    okCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** Undefined when no call in the run reported a price. */
    costUsd?: number;
    unknownCostCalls: number;
    /** Priced calls whose costUsd is the provider-reported amount. */
    reportedCostCalls: number;
  };
  /** Harness-reported usage (CLI stream), when present. */
  harness?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
}

/**
 * Where a cost figure came from: "reported" (every priced call's amount is
 * the provider-reported one), "estimated" (every priced call was priced
 * from local per-token tables — gateway estimates, or the harness CLI's
 * own total), or "mixed" (both kinds in one run, e.g. failover across
 * providers).
 */
export type CostProvenance = "reported" | "estimated" | "mixed";

/** A classified cost figure plus the call counts the verdict came from. */
export interface CostProvenanceInfo {
  provenance: CostProvenance;
  /** Priced calls (calls − unknownCostCalls). */
  pricedCalls: number;
  /** Of the priced calls, how many carry the provider-reported amount. */
  reportedCalls: number;
}

/**
 * Classify a cost figure's provenance from its accounting counts. Every
 * gateway call either priced (a costUsd was stamped) or counted unknown,
 * so priced calls = calls − unknownCostCalls; of those, reportedCostCalls
 * carry the provider-reported amount. Undefined when there is no figure
 * to classify: cost unknown, a $0 figure (free providers and reported
 * zeros — the $0 stands alone, unlabeled), or counts too inconsistent to
 * classify honestly. Legacy accounting without reportedCostCalls reads
 * as 0 reported — correct, since every cost was an estimate before
 * reported costs were captured. Shared by the report builder (which
 * records the verdict on ReportCardMeta) and the report card (which
 * renders it), so the two can never disagree.
 */
export function classifyCostProvenance(accounting: {
  costUsd?: number;
  calls: number;
  unknownCostCalls: number;
  reportedCostCalls: number;
}): CostProvenanceInfo | undefined {
  const { costUsd } = accounting;
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  const calls = Number.isFinite(accounting.calls) ? accounting.calls : 0;
  const unknown = Number.isFinite(accounting.unknownCostCalls) ? accounting.unknownCostCalls : 0;
  const priced = calls - unknown;
  if (priced <= 0) return undefined;
  const reportedRaw = Number.isFinite(accounting.reportedCostCalls) ? accounting.reportedCostCalls : 0;
  const reported = Math.min(Math.max(reportedRaw, 0), priced);
  const provenance: CostProvenance = reported === priced ? "reported" : reported === 0 ? "estimated" : "mixed";
  return { provenance, pricedCalls: priced, reportedCalls: reported };
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
  /**
   * SHA-256 hex of the file's contents at report-build time (receipt).
   * `null` means the contents could not be hashed — the file was gone by
   * hash time, or it exceeded the hash cap (see `status`). Undefined on
   * reports written before artifact hashing existed.
   */
  sha256?: string | null;
  /**
   * Whether the file's contents were present when hashed. `sha256: null`
   * with `status: "missing"` means the file was gone at hash time (created
   * then deleted mid-run, or larger than the hash cap) — recorded
   * explicitly, never silently omitted from the report.
   */
  status?: "present" | "missing";
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
  /**
   * Where costUsd came from (see CostProvenance): the gateway accounting
   * total classified by its reported/estimated call counts when the run
   * crossed the gateway, else "estimated" for the harness CLI's own
   * total. Absent on reports written before provenance was recorded and
   * when there is no figure worth labeling (no cost, or $0) — the card
   * then shows the figure bare, exactly as before.
   */
  costProvenance?: CostProvenance;
  /** Input tokens moved by the run (gateway totals, else harness totals). */
  tokensIn?: number;
  /** Output tokens moved by the run (gateway totals, else harness totals). */
  tokensOut?: number;
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
  /** Post-run auto-commit result, when the account enabled it. */
  gitCommit?: RunGitCommitMeta;
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

/** The post-run auto-commit result for a run (git.commit telemetry). */
export interface RunGitCommitMeta {
  success: boolean;
  /** The conventional-commit subject that was committed ("" on failure). */
  commitMessage: string;
  /** Files in the commit (empty on failure). */
  filesCommitted: string[];
  /** Committer output: git stdout on success, the failure reason otherwise. */
  output: string;
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
   * Per-model token accounting folded from the run's llm.call / usage
   * telemetry. Absent on reports written before it existed, and on runs
   * whose telemetry carried no usage at all.
   */
  tokenAccounting?: RunTokenAccounting;
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
  /**
   * Post-run auto-commit result, when the account enabled `gitAutoCommit`
   * (derived from the run's git.commit telemetry event).
   */
  gitCommit?: RunGitCommitMeta;
  /**
   * Tamper-evident audit receipt: hash chain over the prompt, approvals,
   * attestations, redacted command logs and artifact hashes, signed with
   * the server secret when one is configured. Attached by the reporter at
   * finalize time; absent on reports written before receipts existed, or
   * when receipt-building failed (the run never fails for it).
   */
  receipt?: RunReceipt;
}
