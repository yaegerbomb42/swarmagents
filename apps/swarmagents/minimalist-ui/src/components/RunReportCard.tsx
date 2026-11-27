"use client";

/**
 * RunReportCard — what a finished run did, one click away from its reply.
 *
 * Collapsed, it is a single row led by one plain-language sentence (what
 * changed, how long it took, what it cost). Expanded, it loads the report
 * from the runtime API: the audit and verification verdicts, a playable
 * desktop replay when one was recorded, the screenshots, the timeline, the
 * files the run changed (each downloadable), and what the agent could not do.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Eye,
  Loader2,
  Play,
  StopCircle,
  X,
} from "lucide-react";
import { classifyCostProvenance } from "../../../lib/runtime/run-report-types";
import type { ReportArtifact, ReportCardMeta, ReportStep, RunReport } from "../../../lib/runtime/run-report-types";
import type { ThreadEntry } from "../../../lib/client/thread";
import { createScheduleFromRun } from "../../../lib/client/schedules";
import { Button, IconButton, Loading, Notice } from "./ui";
import { Card } from "./brand/Card";
import { DesktopReplay } from "./DesktopReplay";
import { PlanChecklist } from "./PlanChecklist";
import {
  InlinePdfPreview,
  RichCsvTable,
  SandboxedHtmlFrame,
  artifactRichRenderer,
  isPdfBytes,
} from "./RichArtifactPreview";
import { formatPlanSummary } from "../../../lib/run-plan";

// Re-exported so the preview tests can import the guard from here.
export { isPdfBytes } from "./RichArtifactPreview";

const POLL_MS = 2000;
const MAX_POLLS = 10;

// --- artifact previews ------------------------------------------------------

/** Max characters shown in an artifact text preview. */
export const ARTIFACT_PREVIEW_MAX_CHARS = 200_000;

/** Max lines shown in an artifact text preview. */
export const ARTIFACT_PREVIEW_MAX_LINES = 500;

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const TEXT_EXTENSIONS = new Set([
  "bat",
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "css",
  "csv",
  "env",
  "example",
  "gitignore",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "log",
  "mjs",
  "md",
  "markdown",
  "php",
  "pl",
  "properties",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

export type ArtifactPreviewKind = "image" | "text" | "none";

/** What an artifact can be previewed as, by extension. */
export function artifactPreviewKind(rel: string): ArtifactPreviewKind {
  const dot = rel.lastIndexOf(".");
  const ext = dot > 0 && dot < rel.length - 1 ? rel.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "none";
}

/**
 * Cap a text preview to maxChars/maxLines. Pure, so the chunking policy is
 * unit-tested without a DOM.
 */
export function capPreviewText(
  text: string,
  maxChars: number = ARTIFACT_PREVIEW_MAX_CHARS,
  maxLines: number = ARTIFACT_PREVIEW_MAX_LINES,
): { text: string; truncated: boolean } {
  let content = text;
  let truncated = content.length > maxChars;
  if (truncated) content = content.slice(0, maxChars);
  const lines = content.split("\n");
  if (lines.length > maxLines) {
    truncated = true;
    content = lines.slice(0, maxLines).join("\n");
  }
  return { text: content, truncated };
}

/** Preview state for one artifact, as loaded by the card. */
export interface ArtifactPreviewState {
  kind: ArtifactPreviewKind;
  /** Object URL for image previews. */
  url?: string;
  /** Capped text for text previews. */
  text?: string;
  truncated?: boolean;
  error?: string;
}

/** The preview block under the files list. Presentational — state comes from the card. */
export function ArtifactPreviewPanel({
  artifact,
  reportRunId,
  state,
  onClose,
}: {
  artifact: ReportArtifact;
  reportRunId: string;
  state: ArtifactPreviewState;
  onClose: () => void;
}) {
  const downloadHref = `/api/runtime/runs/${encodeURIComponent(reportRunId)}/report/artifacts?path=${encodeURIComponent(artifact.rel)}`;
  const rich = artifactRichRenderer(artifact.rel);
  const [rawMode, setRawMode] = useState(false);
  const canToggleRaw = (rich === "html" || rich === "csv") && state.text !== undefined;
  return (
    <div className="mt-2 rounded-lg border border-sa-line bg-sa-panel p-3" data-testid="artifact-preview">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-sa-fg" title={artifact.rel}>
          {artifact.rel}
        </span>
        {canToggleRaw && (
          <button
            type="button"
            onClick={() => setRawMode((prev) => !prev)}
            data-testid="artifact-preview-toggle-raw"
            className="shrink-0 cursor-pointer rounded-md border border-sa-line px-2 py-0.5 text-[11px] text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
          >
            {rawMode ? "Rich" : "Raw"}
          </button>
        )}
        <a
          href={downloadHref}
          download
          aria-label={`Download ${artifact.rel}`}
          title="Download file"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
        </a>
        <IconButton label="Close preview" onClick={onClose}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
      </div>
      {state.error ? (
        <p className="mt-2 text-[12px] text-sa-err" data-testid="artifact-preview-error">
          {state.error}
        </p>
      ) : rich === "pdf" && state.url ? (
        <InlinePdfPreview url={state.url} title={artifact.rel} />
      ) : state.kind === "image" && state.url ? (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL preview is not optimizable
        <img
          src={state.url}
          alt={`Preview of ${artifact.rel}`}
          data-testid="artifact-preview-image"
          className="mt-2 max-h-64 w-full rounded-md object-contain"
          draggable={false}
        />
      ) : rich === "html" && state.text !== undefined && !rawMode ? (
        <SandboxedHtmlFrame html={state.text} title={artifact.rel} />
      ) : rich === "csv" && state.text !== undefined && !rawMode ? (
        <RichCsvTable text={state.text} />
      ) : state.kind === "text" && state.text !== undefined ? (
        <>
          <pre
            className="sa-scroll mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sa-raised p-2 font-mono text-[11px] leading-relaxed text-sa-fg"
            data-testid="artifact-preview-text"
          >
            {state.text}
          </pre>
          {state.truncated && (
            <p className="mt-1 text-[11px] text-sa-fg3">Preview is truncated. Download the file to see the rest.</p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[12px] text-sa-fg3" data-testid="artifact-preview-none">
          No preview for this file type — download it to open it locally.
        </p>
      )}
    </div>
  );
}

export function formatReportDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact token count for the card ("1.2k", "34k", "1.1M"). */
export function formatTokenCount(tokens?: number): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** The collapsed row's numbers, in reading order. */
export function reportFacts(meta: ReportCardMeta): string[] {
  const facts = [`${meta.steps} ${meta.steps === 1 ? "step" : "steps"}`];
  if (meta.durationMs !== undefined && Number.isFinite(meta.durationMs)) facts.push(formatReportDuration(meta.durationMs));
  facts.push(`${meta.artifacts} ${meta.artifacts === 1 ? "file" : "files"} changed`);
  if (meta.tokensIn !== undefined || meta.tokensOut !== undefined) {
    facts.push(`${formatTokenCount((meta.tokensIn ?? 0) + (meta.tokensOut ?? 0))} tokens`);
  }
  if (meta.costUsd !== undefined) {
    const label = metaCostProvenanceLabel(meta);
    facts.push(`$${meta.costUsd.toFixed(3)}${label ? ` (${label})` : ""}`);
  }
  return facts;
}

export function formatReportCost(costUsd?: number): string {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return "";
  const subCent = costUsd !== 0 && costUsd < 0.005;
  return `$${costUsd.toFixed(subCent ? 3 : 2)}`;
}

function filesSummary(meta: ReportCardMeta, artifacts?: ReportArtifact[]): string {
  if (!artifacts) {
    const n = meta.artifacts;
    return n === 0 ? "No files changed" : `Changed ${n} ${n === 1 ? "file" : "files"}`;
  }
  if (artifacts.length === 0) return "No files changed";
  const created = artifacts.filter((artifact) => artifact.change === "created");
  const edited = artifacts.filter((artifact) => artifact.change !== "created");
  const counted = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  if (created.length === 1 && edited.length === 0) return `Created ${created[0].rel}`;
  if (created.length === 0 && edited.length === 1) return `Edited ${edited[0].rel}`;
  if (created.length > 0 && edited.length > 0) return `Created ${counted(created.length)} and edited ${counted(edited.length)}`;
  return created.length > 0 ? `Created ${counted(created.length)}` : `Edited ${counted(edited.length)}`;
}

/**
 * One plain-language sentence for the report card, computed from data the
 * card already has: what changed, how long it took, and what it cost. With
 * the report loaded the files phrase can name the file ("Created hello.txt");
 * from the collapsed row's meta alone it counts ("Changed 2 files").
 */
export function reportSummarySentence(meta: ReportCardMeta, artifacts?: ReportArtifact[]): string {
  const parts = [filesSummary(meta, artifacts)];
  if (meta.durationMs !== undefined && Number.isFinite(meta.durationMs)) parts.push(`in ${formatReportDuration(meta.durationMs)}`);
  const cost = formatReportCost(meta.costUsd);
  const costLabel = metaCostProvenanceLabel(meta);
  if (cost) parts.push(`for ${cost}${costLabel ? ` (${costLabel})` : ""}`);
  const body = parts.join(" ");
  const prefix = meta.status === "error" ? "Run failed \u2014 " : meta.status === "cancelled" ? "Run stopped \u2014 " : "";
  const sentence = prefix ? prefix + body.charAt(0).toLowerCase() + body.slice(1) : body;
  const plan = meta.plan && meta.plan.total > 0 ? ` ${formatPlanSummary(meta.plan)}.` : "";
  return `${sentence}.${plan}`;
}

/** The outcome word shown beside a timeline step, mirroring the visible report. */
function stepOutcome(step: ReportStep): string {
  if (step.kind === "blocked") return "blocked";
  if (step.ok === false || (step.kind === "end" && step.text.startsWith("Error"))) return "failed";
  if (step.ok === true) return "done";
  return "";
}

/**
 * Build the markdown transcript from the report already loaded in the card —
 * no extra fetch. The sections follow the same order and wording as the
 * visible report so what you copy matches what you read.
 */
export function buildTranscriptMarkdown(report: RunReport): string {
  const lines: string[] = ["# Run transcript", ""];
  lines.push(`Status: ${report.status}`, "");
  lines.push("## Prompt", "", report.prompt, "");
  if (report.plan && report.plan.length > 0) {
    const done = report.plan.filter((step) => step.status === "completed").length;
    lines.push(`## Plan (${done}/${report.plan.length} completed)`, "");
    for (const step of report.plan) {
      const box = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[~]" : "[ ]";
      lines.push(`- ${box} ${step.content}`);
    }
    lines.push("");
  }
  lines.push("## Timeline", "");
  if (report.steps.length === 0) {
    lines.push("_No steps recorded._");
  } else {
    for (const step of report.steps) {
      const outcome = stepOutcome(step);
      const detail = step.detail ? ` — ${step.detail}` : "";
      lines.push(`- ${step.text}${outcome ? ` (${outcome})` : ""}${detail}`);
    }
  }
  lines.push("");
  lines.push("## Files changed", "");
  if (report.artifacts.length === 0) {
    lines.push("No files changed.");
  } else {
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.change}: \`${artifact.rel}\` (${formatBytes(artifact.size)})`);
    }
  }
  lines.push("");
  const meta = report.meta;
  const duration = meta?.durationMs !== undefined && Number.isFinite(meta.durationMs)
    ? formatReportDuration(meta.durationMs)
    : undefined;
  const costLabel = meta ? metaCostProvenanceLabel(meta) : undefined;
  const cost = meta?.costUsd !== undefined && Number.isFinite(meta.costUsd) ? `$${meta.costUsd.toFixed(3)}${costLabel ? ` (${costLabel})` : ""}` : undefined;
  lines.push(`**Duration / cost:** ${[duration, cost].filter(Boolean).join(" · ") || "—"}`);
  const usageLines = tokenUsageLines(report);
  if (usageLines.length > 0) {
    lines.push("", "## Token usage", "", ...usageLines);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Where a cost figure came from, as a short label: "reported" (the
 * provider's own billed amount on every priced call), "estimated" (every
 * priced call priced from the local tables), or "mixed: N reported, M
 * estimated". The classification itself is classifyCostProvenance
 * (lib/runtime/run-report-types) — the same code the report builder uses
 * to record meta.costProvenance, so the collapsed row and these lines can
 * never disagree. Undefined when there is no figure to label: cost
 * unknown, a $0 figure (free providers and reported zeros — the $0
 * stands alone, unchanged), or counts too inconsistent to classify
 * honestly. Legacy reports without reportedCostCalls read as 0 reported
 * — correct, since every cost was an estimate before reported costs
 * were captured.
 */
export function costProvenanceLabel(accounting: {
  costUsd?: number;
  calls: number;
  unknownCostCalls: number;
  reportedCostCalls: number;
}): string | undefined {
  const info = classifyCostProvenance(accounting);
  if (!info) return undefined;
  if (info.provenance !== "mixed") return info.provenance;
  return `mixed: ${info.reportedCalls} reported, ${info.pricedCalls - info.reportedCalls} estimated`;
}

/**
 * The collapsed row's cost label, from the provenance the report builder
 * recorded on the meta: "reported", "estimated", or "mixed" (the counts
 * live in the expanded Token usage lines). Undefined — the figure stands
 * bare, exactly as before — when the report predates provenance (field
 * absent) or there is no figure worth labeling (no cost, or $0, matching
 * costProvenanceLabel's silence rules).
 */
export function metaCostProvenanceLabel(meta: ReportCardMeta): string | undefined {
  const { costUsd, costProvenance } = meta;
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  return costProvenance;
}

/**
 * The per-model token accounting as plain lines (shared by the transcript
 * and the expanded card). Each cost is labeled with where it came from —
 * the provider-reported amount, a local estimate, or a mix (see
 * costProvenanceLabel); a model with no priced calls reads "cost unknown"
 * — never a fabricated number.
 */
export function tokenUsageLines(report: RunReport): string[] {
  const accounting = report.tokenAccounting;
  if (!accounting) return [];
  const lines: string[] = [];
  for (const model of accounting.byModel) {
    const provenance = costProvenanceLabel(model);
    const cost =
      model.costUsd !== undefined
        ? `$${model.costUsd.toFixed(3)}${provenance ? ` (${provenance})` : ""}`
        : "cost unknown";
    const unknown =
      model.unknownCostCalls > 0 && model.costUsd !== undefined
        ? ` (+${model.unknownCostCalls} unpriced)`
        : "";
    lines.push(
      `- ${model.provider}/${model.model}: ${model.okCalls}/${model.calls} calls, ` +
        `${formatTokenCount(model.inputTokens)} in / ${formatTokenCount(model.outputTokens)} out, ${cost}${unknown}`,
    );
  }
  if (accounting.byModel.length > 1) {
    const t = accounting.totals;
    const totalProvenance = costProvenanceLabel(t);
    lines.push(
      `- Total: ${t.okCalls}/${t.calls} calls, ${formatTokenCount(t.inputTokens)} in / ` +
        `${formatTokenCount(t.outputTokens)} out` +
        (t.costUsd !== undefined
          ? `, $${t.costUsd.toFixed(3)}${totalProvenance ? ` (${totalProvenance})` : ""}`
          : ", cost unknown"),
    );
  }
  if (accounting.harness && accounting.byModel.length === 0) {
    const h = accounting.harness;
    lines.push(
      `- ${formatTokenCount(h.inputTokens)} in / ${formatTokenCount(h.outputTokens)} out` +
        (h.cachedTokens > 0 ? ` (${formatTokenCount(h.cachedTokens)} cached)` : ""),
    );
  }
  return lines;
}

/**
 * Copy text with the async clipboard API, falling back to select-and-copy.
 * Returns false when both fail so the caller can show a manual-copy notice.
 */
export async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or unavailable: try the selection fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Presentational so both button states can be checked without a DOM. */
export function CopyTranscriptButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <Button size="sm" data-testid="copy-transcript" onClick={onCopy}>
      {copied ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : "Copy transcript"}
    </Button>
  );
}

/**
 * Intervals offered when scheduling a finished run. Daily is the default:
 * every scheduled run spends the user's own provider key, so the cheapest
 * cadence is pre-selected and nothing recurs until the user confirms.
 */
export const SCHEDULE_INTERVAL_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 1440, label: "daily" },
  { minutes: 360, label: "every 6h" },
  { minutes: 60, label: "hourly" },
];

export type ScheduleButtonState = "idle" | "confirm" | "saving" | "saved" | "error";

function intervalLabel(minutes: number): string {
  return SCHEDULE_INTERVAL_OPTIONS.find((o) => o.minutes === minutes)?.label ?? `every ${minutes}m`;
}

/**
 * Turn a finished run into a recurring schedule. Two steps: the first click
 * only opens a confirm row (interval picker + a note that each run uses the
 * user's key); the schedule is created on Confirm.
 */
export function ScheduleRunButton({
  state,
  intervalMinutes = SCHEDULE_INTERVAL_OPTIONS[0].minutes,
  onSchedule,
  onIntervalChange,
  onConfirm,
  onCancel,
}: {
  state: ScheduleButtonState;
  intervalMinutes?: number;
  onSchedule: () => void;
  onIntervalChange?: (minutes: number) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  if (state === "confirm") {
    return (
      <div className="flex items-center gap-1.5" data-testid="schedule-confirm">
        <select
          aria-label="Repeat"
          data-testid="schedule-interval"
          value={intervalMinutes}
          onChange={(e) => onIntervalChange?.(Number(e.target.value))}
          className="h-8 rounded-md border border-white/10 bg-black/40 px-1.5 text-xs text-white/80"
        >
          {SCHEDULE_INTERVAL_OPTIONS.map((o) => (
            <option key={o.minutes} value={o.minutes}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-white/45">each run uses your key</span>
        <Button size="sm" data-testid="schedule-confirm-button" onClick={onConfirm}>
          Confirm
        </Button>
        <Button size="sm" variant="ghost" data-testid="schedule-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Button
      size="sm"
      loading={state === "saving"}
      disabled={state === "saved"}
      data-testid="schedule-from-run"
      onClick={onSchedule}
      title="Run this task again on a schedule"
    >
      {state === "saved" ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
      ) : (
        <Clock className="h-3.5 w-3.5" aria-hidden />
      )}
      {state === "saved" ? `Scheduled (${intervalLabel(intervalMinutes)})` : state === "error" ? "Retry schedule" : "Schedule"}
    </Button>
  );
}

type VerdictTone = "ok" | "warn" | "err";

const VERDICT_TEXT: Record<VerdictTone, string> = { ok: "text-sa-ok", warn: "text-sa-warn", err: "text-sa-err" };

function Verdict({ tone, title, detail }: { tone: VerdictTone; title: string; detail?: string }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertTriangle : StopCircle;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-sa-line bg-sa-raised px-3 py-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${VERDICT_TEXT[tone]}`} aria-hidden />
      <div className="min-w-0">
        <p className={`text-[13px] font-medium ${VERDICT_TEXT[tone]}`}>{title}</p>
        {detail && <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-sa-fg2">{detail}</p>}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1.5 text-[12px] font-medium text-sa-fg3">{children}</h4>;
}

export function RunReportCard({ entry }: { entry: ThreadEntry }) {
  // The facts on the closed row come with the run (they arrive on a later
  // poll for a run that just ended); opening the report refreshes them.
  const [loadedMeta, setLoadedMeta] = useState<ReportCardMeta>();
  const meta = loadedMeta ?? entry.report;
  const [report, setReport] = useState<RunReport | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [shotIndex, setShotIndex] = useState(0);
  const [attempts, setAttempts] = useState(0);
  // Receipt verification: never show a pass badge without server verification.
  const [receiptStatus, setReceiptStatus] = useState<"idle" | "loading" | "verified" | "failed">("idle");
  const [receiptLinks, setReceiptLinks] = useState(0);
  const [receiptFailedLink, setReceiptFailedLink] = useState<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [copyNotice, setCopyNotice] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const [previewArtifact, setPreviewArtifact] = useState<ReportArtifact | null>(null);
  const [preview, setPreview] = useState<ArtifactPreviewState | undefined>();
  const previewUrlRef = useRef<string | undefined>(undefined);
  const previewTokenRef = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/runtime/runs/${encodeURIComponent(entry.runId)}/report`, {
          signal,
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as RunReport;
        if (signal?.aborted) return;
        setLoadedMeta(body.meta);
        setReport(body);
        setReceiptStatus("idle");
        setReceiptFailedLink(undefined);
        setAttempts(0);
      } catch {
        // The next poll tries again; after the last one the card says so.
      }
    },
    [entry.runId],
  );

  const transcript = report ? buildTranscriptMarkdown(report) : "";

  // Copy the transcript built from the loaded report. If the clipboard is
  // unavailable (permission denied, non-secure context), fall back to a
  // select-and-copy textarea and say so instead of failing silently.
  const onCopy = useCallback(async () => {
    if (!report) return;
    const ok = await copyTextWithFallback(buildTranscriptMarkdown(report));
    if (ok) {
      setCopied(true);
      setCopyNotice(false);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } else {
      setCopyNotice(true);
    }
  }, [report]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // Revoke object URLs for previewed images/PDFs so they never leak, including
  // when a preview is closed or replaced by a non-URL state.
  useEffect(() => {
    const nextUrl = preview?.url;
    if (nextUrl !== previewUrlRef.current) {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = nextUrl;
    }
  }, [preview]);
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  // Fetch the artifact bytes for the preview panel. Each open bumps a token so
  // a stale in-flight response can never overwrite a newer preview.
  const openPreview = useCallback(
    async (artifact: ReportArtifact) => {
      const kind = artifactPreviewKind(artifact.rel);
      const rich = artifactRichRenderer(artifact.rel);
      const token = ++previewTokenRef.current;
      setPreviewArtifact(artifact);
      setPreview({ kind });
      if (kind === "none" && rich !== "pdf") return;
      try {
        const res = await fetch(
          `/api/runtime/runs/${encodeURIComponent(report?.runId ?? "")}/report/artifacts?path=${encodeURIComponent(artifact.rel)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (token !== previewTokenRef.current) return;
        if (rich === "pdf") {
          const bytes = await res.arrayBuffer();
          if (token !== previewTokenRef.current) return;
          if (!isPdfBytes(bytes)) {
            // Not a real PDF: fall back to the download link instead of
            // handing untrusted bytes to the viewer.
            setPreview({ kind: "none" });
            return;
          }
          const blob = new Blob([bytes], { type: "application/pdf" });
          if (token !== previewTokenRef.current) return;
          setPreview({ kind, url: URL.createObjectURL(blob) });
        } else if (kind === "image") {
          const blob = await res.blob();
          if (token !== previewTokenRef.current) return;
          setPreview({ kind, url: URL.createObjectURL(blob) });
        } else {
          const text = await res.text();
          const capped = capPreviewText(text);
          if (token !== previewTokenRef.current) return;
          setPreview({ kind: "text", text: capped.text, truncated: capped.truncated });
        }
      } catch {
        if (token !== previewTokenRef.current) return;
        setPreview({ kind, error: "Could not load the preview." });
      }
    },
    [report],
  );

  const closePreview = useCallback(() => {
    previewTokenRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = undefined;
    }
    setPreviewArtifact(null);
    setPreview(undefined);
  }, []);

  // A different run's report resets any open preview.
  useEffect(() => {
    closePreview();
  }, [report, closePreview]);

  // The report may lag a finished run by a moment: poll briefly, then stop and
  // offer a retry.
  useEffect(() => {
    if (!expanded || report || attempts >= MAX_POLLS) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const timer = window.setTimeout(() => setAttempts((n) => n + 1), POLL_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [expanded, report, attempts, load]);

  useEffect(() => {
    setShotIndex(0);
  }, [expanded]);

  const [scheduleState, setScheduleState] = useState<ScheduleButtonState>("idle");
  const [scheduleInterval, setScheduleInterval] = useState<number>(SCHEDULE_INTERVAL_OPTIONS[0].minutes);
  const [scheduleError, setScheduleError] = useState<string>();
  const onConfirmSchedule = useCallback(async () => {
    if (!report?.prompt || scheduleState === "saving") return;
    setScheduleState("saving");
    setScheduleError(undefined);
    const res = await createScheduleFromRun({ prompt: report.prompt, intervalMinutes: scheduleInterval });
    if (res.ok) {
      setScheduleState("saved");
    } else {
      setScheduleState("error");
      setScheduleError(res.error);
    }
  }, [report?.prompt, scheduleState, scheduleInterval]);

  // Verify the stored receipt server-side once the report is loaded. The
  // badge only ever shows a pass after this endpoint confirms it, and only
  // when the shadow-verifier gate passed too.
  useEffect(() => {
    if (!report?.receipt) return;
    if (!report.verification?.passed) return;
    if (receiptStatus !== "idle") return;
    const ctrl = new AbortController();
    setReceiptStatus("loading");
    void fetch(`/api/runtime/runs/${encodeURIComponent(report.runId)}/report/receipt/verify`, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok || ctrl.signal.aborted) {
          if (!ctrl.signal.aborted) setReceiptStatus("failed");
          return;
        }
        const body = (await res.json()) as { ok?: boolean; failedLink?: number };
        if (ctrl.signal.aborted) return;
        if (body.ok) {
          setReceiptLinks(report.receipt?.links.length ?? 0);
          setReceiptStatus("verified");
        } else {
          setReceiptFailedLink(body.failedLink);
          setReceiptStatus("failed");
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setReceiptStatus("failed");
      });
    return () => {
      ctrl.abort();
    };
  }, [report, receiptStatus]);

  const shots = report?.shots ?? [];
  useEffect(() => {
    if (shotIndex >= shots.length) setShotIndex(Math.max(0, shots.length - 1));
  }, [shots.length, shotIndex]);

  const currentShot = shots[shotIndex];
  const currentStepText = currentShot
    ? (report?.steps.find((step) => step.shot === shotIndex)?.text ?? currentShot.label)
    : "";
  const waiting = expanded && !report && attempts < MAX_POLLS;
  const unavailable = expanded && !report && attempts >= MAX_POLLS;
  const summary = meta ? reportSummarySentence(meta, report?.artifacts) : "";

  return (
    <Card flush className="mt-2 overflow-hidden" data-testid="run-report">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid="run-report-toggle"
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
      >
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="font-medium text-sa-fg">Report</span>
        {meta && (
          <span
            className="sa-tabular ml-auto min-w-0 truncate pl-3 text-[12px] text-sa-fg2"
            data-testid="run-report-summary"
            title={summary}
          >
            {summary}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-sa-line px-3 py-3" data-testid="run-report-body">
          {waiting && <Loading label="Preparing the report" className="py-3" />}

          {unavailable && (
            <Notice
              tone="info"
              title="No report for this run"
              action={
                <Button size="sm" onClick={() => setAttempts(0)}>
                  Try again
                </Button>
              }
            >
              A report is written when a run finishes. This one has none yet.
            </Notice>
          )}

          {report && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <SectionTitle>Transcript</SectionTitle>
                <div className="flex items-center gap-1.5">
                  {report.prompt.trim().length > 0 && (
                    <ScheduleRunButton
                      state={scheduleState}
                      intervalMinutes={scheduleInterval}
                      onSchedule={() => setScheduleState("confirm")}
                      onIntervalChange={setScheduleInterval}
                      onConfirm={() => void onConfirmSchedule()}
                      onCancel={() => setScheduleState("idle")}
                    />
                  )}
                  <CopyTranscriptButton copied={copied} onCopy={() => void onCopy()} />
                </div>
              </div>
              {scheduleError && (
                <p className="text-[11px] text-sa-err" data-testid="schedule-from-run-error">
                  {scheduleError}
                </p>
              )}
              {copyNotice && (
                <Notice tone="info" title="Clipboard unavailable">
                  Select the transcript below and copy it manually.
                  <textarea
                    readOnly
                    value={transcript}
                    data-testid="transcript-fallback"
                    className="mt-2 block h-32 w-full resize-none rounded-lg border border-sa-line bg-sa-raised p-2 font-mono text-[11px] text-sa-fg"
                  />
                </Notice>
              )}
              {report.audit && (
                <Verdict
                  tone={report.audit.verdict === "warn" ? "warn" : "ok"}
                  title={report.audit.verdict === "warn" ? "Security audit found warnings" : "Security audit passed"}
                  detail={report.audit.text || undefined}
                />
              )}

              {report.verification && (
                <Verdict
                  tone={report.verification.badge === "pass" ? "ok" : report.verification.badge === "warn" ? "warn" : "err"}
                  title={
                    report.verification.badge === "pass"
                      ? `Verification passed · ${report.verification.score}/100`
                      : report.verification.badge === "warn"
                        ? `Verification · ${report.verification.score}/100`
                        : `Verification failed · ${report.verification.score}/100`
                  }
                  detail={report.verification.violations.length > 0 ? report.verification.violations.join("; ") : undefined}
                />
              )}

              {/* Audit receipt: only when verification passed, and only a
                  server-verified pass ever shows as verified. */}
              {report.receipt && report.verification?.passed && (
                <div
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                    receiptStatus === "verified"
                      ? "border-sa-ok/30 bg-sa-ok/5"
                      : receiptStatus === "failed"
                        ? "border-sa-warn/30 bg-sa-warn/5"
                        : "border-sa-line bg-sa-panel"
                  }`}
                >
                  {receiptStatus === "verified" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sa-ok" />
                  ) : receiptStatus === "failed" ? (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sa-warn" />
                  ) : (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sa-fg3" />
                  )}
                  <div className="min-w-0">
                    <p
                      className={`text-[11px] font-medium ${
                        receiptStatus === "verified"
                          ? "text-sa-ok"
                          : receiptStatus === "failed"
                            ? "text-sa-warn"
                            : "text-sa-fg3"
                      }`}
                    >
                      {receiptStatus === "verified"
                        ? `Receipt verified · ${receiptLinks} links`
                        : receiptStatus === "failed"
                          ? "Receipt verification failed"
                          : "Verifying receipt…"}
                    </p>
                    {receiptStatus === "failed" && receiptFailedLink !== undefined && (
                      <p className="mt-1 text-[11px] leading-relaxed text-sa-fg2">
                        Chain link {receiptFailedLink} does not re-derive.
                      </p>
                    )}
                    {receiptStatus === "failed" && receiptFailedLink === undefined && (
                      <p className="mt-1 text-[11px] leading-relaxed text-sa-fg2">
                        The stored receipt did not verify (chain or signature).
                      </p>
                    )}
                  </div>
                </div>
              )}

              {report.replay && (
                <DesktopReplay
                  runId={report.runId}
                  width={report.replay.width}
                  height={report.replay.height}
                />
              )}

              {shots.length > 0 && (
                <div>
                  <SectionTitle>Screenshots</SectionTitle>
                  <div className="overflow-hidden rounded-lg border border-sa-line bg-black">
                    <img
                      src={`/api/runtime/runs/${encodeURIComponent(report.runId)}/report/shots/${shotIndex}`}
                      alt={`Screenshot: ${currentShot?.label ?? ""}`}
                      className="block aspect-video w-full object-contain"
                      draggable={false}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <IconButton
                      label="Previous screenshot"
                      onClick={() => setShotIndex((i) => Math.max(0, i - 1))}
                      disabled={shotIndex === 0}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, shots.length - 1)}
                      value={shotIndex}
                      onChange={(e) => setShotIndex(Number(e.target.value))}
                      className="h-1 min-w-0 flex-1 cursor-pointer accent-sa-accent"
                      aria-label="Scrub screenshots"
                    />
                    <IconButton
                      label="Next screenshot"
                      onClick={() => setShotIndex((i) => Math.min(shots.length - 1, i + 1))}
                      disabled={shotIndex >= shots.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <span className="sa-tabular shrink-0 pl-1 text-[12px] text-sa-fg3">
                      {shotIndex + 1} / {shots.length}
                    </span>
                  </div>
                  {currentStepText && <p className="mt-1 break-words text-[12px] text-sa-fg2">{currentStepText}</p>}
                </div>
              )}

              <div>
                <SectionTitle>Files changed</SectionTitle>
                {report.artifacts.length === 0 ? (
                  <p className="text-[13px] text-sa-fg2">The run did not create or change any files in /workspace.</p>
                ) : (
                  <>
                    <ul className="sa-scroll max-h-48 overflow-y-auto" data-testid="run-report-files">
                      {report.artifacts.map((artifact) => {
                        const previewing = previewArtifact?.rel === artifact.rel;
                        return (
                          <li key={artifact.path} className="flex min-h-8 items-center gap-2">
                            <span className="w-16 shrink-0 text-[12px] text-sa-fg3">{artifact.change}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-sa-fg" title={artifact.rel}>
                              {artifact.rel}
                            </span>
                            <span className="sa-tabular shrink-0 text-[12px] text-sa-fg3">{formatBytes(artifact.size)}</span>
                            <button
                              type="button"
                              onClick={() => (previewing ? closePreview() : void openPreview(artifact))}
                              aria-label={`Preview ${artifact.rel}`}
                              title="Preview"
                              data-testid="artifact-preview-toggle"
                              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${
                                previewing
                                  ? "bg-sa-hover text-sa-fg"
                                  : "text-sa-fg2 hover:bg-sa-hover hover:text-sa-fg"
                              }`}
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <a
                              href={`/api/runtime/runs/${encodeURIComponent(report.runId)}/report/artifacts?path=${encodeURIComponent(artifact.rel)}`}
                              download
                              aria-label={`Download ${artifact.rel}`}
                              title={`Download ${artifact.rel}`}
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden />
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                    {previewArtifact && preview && (
                      <ArtifactPreviewPanel
                        artifact={previewArtifact}
                        reportRunId={report.runId}
                        state={preview}
                        onClose={closePreview}
                      />
                    )}
                  </>
                )}
              </div>

              {report.plan && report.plan.length > 0 && (
                <div data-testid="run-report-plan">
                  <SectionTitle>Plan</SectionTitle>
                  <PlanChecklist plan={report.plan} defaultOpen />
                </div>
              )}

              <div>
                <SectionTitle>Timeline</SectionTitle>
                <ol className="sa-scroll max-h-56 space-y-1.5 overflow-y-auto">
                  {report.steps.map((step) => {
                    const failed = step.ok === false || (step.kind === "end" && step.text.startsWith("Error"));
                    return (
                      <li key={`${step.kind}:${step.seq}`} className="flex items-start gap-2 text-[13px] leading-snug">
                        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
                          {failed || step.kind === "blocked" ? (
                            step.kind === "blocked" ? (
                              <StopCircle className="h-3.5 w-3.5 text-sa-err" />
                            ) : (
                              <AlertTriangle className="h-3.5 w-3.5 text-sa-err" />
                            )
                          ) : step.kind === "end" ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-sa-ok" />
                          ) : step.kind === "desktop" ? (
                            <Camera className="h-3.5 w-3.5 text-sa-fg3" />
                          ) : step.kind === "tool" ? (
                            <Play className="h-3.5 w-3.5 text-sa-fg3" />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-sa-fg3" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className={`break-words ${step.ok === false ? "text-sa-err" : "text-sa-fg"}`}>{step.text}</span>
                          {step.detail && <span className="block break-words text-[12px] text-sa-fg3">{step.detail}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {/* The reply above the card is the summary; repeat it only when the report has a different one. */}
              {report.finalText && report.finalText !== entry.finalText && (
                <div>
                  <SectionTitle>Summary</SectionTitle>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-sa-fg">{report.finalText}</p>
                </div>
              )}

              {tokenUsageLines(report).length > 0 && (
                <div>
                  <SectionTitle>Token usage</SectionTitle>
                  <ul className="space-y-1 text-[12px] leading-relaxed text-sa-fg3">
                    {tokenUsageLines(report).map((line, i) => (
                      <li key={i} className="break-words">
                        {line.replace(/^- /, "")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.couldNotDo.length > 0 && (
                <Notice tone="warn" title="What the agent could not do">
                  <ul className="sa-scroll max-h-32 space-y-1 overflow-y-auto">
                    {report.couldNotDo.map((line, i) => (
                      <li key={i} className="break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
