"use client";

/**
 * RunReportCard — what a finished run did, one click away from its reply.
 *
 * Collapsed, it is a single row with the numbers (steps, time, files changed,
 * cost). Expanded, it loads the report from the runtime API: the audit and
 * verification verdicts, the screenshots, the timeline, the files the run
 * changed (each downloadable), and what the agent could not do.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Play,
  StopCircle,
} from "lucide-react";
import type { ReportCardMeta, RunReport } from "../../../lib/runtime/run-report-types";
import type { ThreadEntry } from "../../../lib/client/thread";
import { Button, IconButton, Loading, Notice } from "./ui";

const POLL_MS = 2000;
const MAX_POLLS = 10;

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

/** The collapsed row's numbers, in reading order. */
export function reportFacts(meta: ReportCardMeta): string[] {
  const facts = [`${meta.steps} ${meta.steps === 1 ? "step" : "steps"}`];
  if (meta.durationMs !== undefined && Number.isFinite(meta.durationMs)) facts.push(formatReportDuration(meta.durationMs));
  facts.push(`${meta.artifacts} ${meta.artifacts === 1 ? "file" : "files"} changed`);
  if (meta.costUsd !== undefined) facts.push(`$${meta.costUsd.toFixed(3)}`);
  return facts;
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
        setAttempts(0);
      } catch {
        // The next poll tries again; after the last one the card says so.
      }
    },
    [entry.runId],
  );

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

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-sa-line bg-sa-panel" data-testid="run-report">
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
          <span className="sa-tabular ml-auto flex min-w-0 flex-wrap justify-end gap-x-3 text-[12px] text-sa-fg3">
            {reportFacts(meta).map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
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
                  <ul className="sa-scroll max-h-48 overflow-y-auto" data-testid="run-report-files">
                    {report.artifacts.map((artifact) => (
                      <li key={artifact.path} className="flex min-h-8 items-center gap-2">
                        <span className="w-16 shrink-0 text-[12px] text-sa-fg3">{artifact.change}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-sa-fg" title={artifact.rel}>
                          {artifact.rel}
                        </span>
                        <span className="sa-tabular shrink-0 text-[12px] text-sa-fg3">{formatBytes(artifact.size)}</span>
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
                    ))}
                  </ul>
                )}
              </div>

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
    </div>
  );
}
