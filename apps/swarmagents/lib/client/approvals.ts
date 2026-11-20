/**
 * approvals.ts — client helper for the approval gate.
 *
 * The approval UI (ApprovalGate) posts the user's Allow/Deny decision to
 * `POST /api/runtime/approvals/{id}`; the runtime resolves the paused run and
 * the run stream then confirms with an approval.resolved event. Kept as a tiny
 * pure-ish module (fetch injectable) so the decision path is unit-testable
 * without a DOM.
 */

export type ApprovalDecision = "approve" | "deny";

/** Whole seconds left before an approval auto-denies (undefined without a deadline). */
export function approvalSecondsLeft(expiresAt: number | undefined, now: number = Date.now()): number | undefined {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return undefined;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** Compact m:ss countdown label for an approval card. */
export function formatApprovalCountdown(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds <= 0) return "expired";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}s`;
}

export interface ApprovalDecisionResult {
  ok: boolean;
  /** Store status echoed by the API ("approved"/"denied") on success. */
  status?: string;
  /** Human-readable failure reason when ok is false. */
  error?: string;
}

export async function postApprovalDecision(
  id: string,
  decision: ApprovalDecision,
  fetchImpl: typeof fetch = fetch,
): Promise<ApprovalDecisionResult> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/runtime/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "decision request failed" };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { ok: true, status: body.status };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return {
    ok: false,
    error: body.error ?? `decision rejected (${res.status})`,
  };
}
