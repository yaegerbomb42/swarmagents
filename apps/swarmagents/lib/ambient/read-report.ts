import type { RunReport } from "../runtime/run-report-types";

/** Minimal shape the ambient report reader needs; any RunReport satisfies it. */
export type RunReportLike = Pick<RunReport, "status"> & { finalText?: string };

/**
 * Build the ambient engine's `readReport` dep from a single underlying reader.
 *
 * The inline closure this replaces called readRunReport(runId) three times per
 * delivery — once for the existence check and twice for the fields — so each
 * report delivery cost three disk reads. This reads exactly once.
 */
export function createReadReport(
  read: (runId: string) => RunReportLike | null,
): (runId: string) => { status?: string; summary?: string } | null {
  return (runId) => {
    const report = read(runId);
    if (!report) return null;
    return {
      status: report.status,
      summary: report.finalText?.slice(0, 500),
    };
  };
}
