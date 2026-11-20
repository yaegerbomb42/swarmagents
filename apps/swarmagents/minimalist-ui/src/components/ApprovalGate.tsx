"use client";

// ApprovalGate — inline approval card for pending run approvals (z2).
//
// Replaces the narration/telemetry interruption point with an alertdialog that
// takes focus: exact command, working dir, why, impact, a 3-segment risk meter,
// and Approve / Deny / Always allow for this run. Wired to the existing
// approvals API (approve/deny); "Always allow for this run" approves the
// current request and auto-approves subsequent pending approvals for the run.

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  approvalSecondsLeft,
  formatApprovalCountdown,
  postApprovalDecision,
  type ApprovalDecision,
} from "../../../lib/client/approvals";
import { approvalRiskSegments } from "../../../lib/client/approvalRisk";
import type { ApprovalEntry } from "../../../lib/client/runTimeline";
import { useFocusTrap } from "../utils/focusTrap";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Friendly labels for the permission keys carried by a role escalation. */
const PERMISSION_LABELS: Record<string, string> = {
  readOnly: "write access (read-only removed)",
  allowBash: "Shell",
  allowWrite: "Write files",
  allowNetwork: "Network",
  allowBrowser: "Browser",
  allowSubagents: "Subagents",
};

function escalationAdds(approval: ApprovalEntry): string[] {
  const labels: string[] = [];
  for (const key of approval.addedPermissions ?? []) labels.push(PERMISSION_LABELS[key] ?? key);
  for (const tool of approval.addedTools ?? []) labels.push(tool);
  for (const server of approval.addedMcpServers ?? []) labels.push(`${server} MCP`);
  return labels;
}

const RISK_STYLES = {
  low: {
    border: "border-l-zinc-500",
    badge: "bg-zinc-400/10 text-zinc-300/90",
    text: "text-zinc-300/90",
    bar: "bg-zinc-400/70",
    segmentOn: "bg-zinc-300/80",
  },
  review: {
    border: "border-l-amber-400",
    badge: "bg-amber-400/10 text-amber-300/90",
    text: "text-amber-300/90",
    bar: "bg-amber-400/70",
    segmentOn: "bg-amber-400/80",
  },
  high: {
    border: "border-l-rose-500",
    badge: "bg-rose-500/15 text-rose-300",
    text: "text-rose-300/90",
    bar: "bg-rose-400/70",
    segmentOn: "bg-rose-400/90",
  },
} as const;

const DEFAULT_IMPACT: Record<string, string> = {
  allow: "Reads from your isolated Linux sandbox.",
  ask: "Writes to your isolated Linux sandbox and may change workspace state.",
  deny: "Runs with your VM user permissions and can change or delete workspace files.",
};

export function ApprovalGate({ approvals }: { approvals: ApprovalEntry[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const autoApprovedRef = useRef<Set<string>>(new Set());
  const pendingVisible = approvals.some((a) => a.status === "pending");
  // An approval arrives on its own, often while the user is typing a follow-up.
  // The cursor stays in their field then: with it in the prompt, the next "a"
  // or "d" they typed would approve or deny the action (see the shortcuts below).
  const dialogRef = useFocusTrap<HTMLDivElement>(pendingVisible, { deferToTyping: true });

  const hasDeadline = approvals.some((a) => a.status === "pending" && a.expiresAt !== undefined);
  useEffect(() => {
    if (!hasDeadline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasDeadline]);

  useEffect(() => {
    if (copiedId === null) return;
    const timer = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  const visible = approvals.filter((a) => a.status === "pending" && !dismissed[a.id]);

  const decide = async (approval: ApprovalEntry, decision: ApprovalDecision) => {
    if (busyId) return;
    setBusyId(approval.id);
    setError(null);
    setDismissed((prev) => ({ ...prev, [approval.id]: true }));
    const result = await postApprovalDecision(approval.id, decision);
    if (!result.ok) {
      setDismissed((prev) => {
        const next = { ...prev };
        delete next[approval.id];
        return next;
      });
      setError(result.error ?? "decision failed");
      setBusyId(null);
      return false;
    }
    setBusyId(null);
    return true;
  };

  // "Always allow for this run": approve current and auto-approve subsequent
  // pending approvals for the same run until the component unmounts/resets.
  const approveAlways = async (approval: ApprovalEntry) => {
    const ok = await decide(approval, "approve");
    if (ok) setAlwaysAllow(true);
  };

  useEffect(() => {
    if (!alwaysAllow) return;
    const pending = approvals.filter((a) => a.status === "pending" && !dismissed[a.id]);
    for (const a of pending) {
      if (autoApprovedRef.current.has(a.id) || busyId) continue;
      autoApprovedRef.current.add(a.id);
      void decide(a, "approve");
    }
  }, [alwaysAllow, approvals, dismissed, busyId]);

  // Reset "always allow" when there are no approvals at all for this run/view.
  useEffect(() => {
    if (approvals.length === 0) {
      setAlwaysAllow(false);
      autoApprovedRef.current.clear();
    }
  }, [approvals.length]);

  const copyAction = (approval: ApprovalEntry) => {
    navigator.clipboard
      .writeText(approval.action)
      .then(() => setCopiedId(approval.id))
      .catch(() => setCopiedId(null));
  };

  // Keyboard shortcuts: A approve, D deny, Shift+A always allow for this run.
  useEffect(() => {
    if (visible.length === 0) return;
    const target = visible[0];
    const onKeyDown = (e: KeyboardEvent) => {
      if (busyId) return;
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void decide(target, "deny");
        return;
      }
      if (key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey && target.kind !== "role_escalation") void approveAlways(target);
        else void decide(target, "approve");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, busyId]);

  if (visible.length === 0) return null;

  const a = visible[0];
  const meter = approvalRiskSegments(a.riskLevel);
  const style = RISK_STYLES[meter.tier];
  const countdown = formatApprovalCountdown(approvalSecondsLeft(a.expiresAt, now));
  const expired = countdown === "expired";
  let fraction: number | undefined;
  if (a.expiresAt !== undefined && a.expiresAt > a.ts) {
    fraction = Math.min(1, Math.max(0, approvalSecondsLeft(a.expiresAt, now) ?? 0) / ((a.expiresAt - a.ts) / 1000));
  }
  const cwd = (a as any).cwd ?? (a as any).workingDir;
  const impact = (a as any).impact ?? DEFAULT_IMPACT[a.riskLevel] ?? DEFAULT_IMPACT.ask;
  const isRoleEscalation = a.kind === "role_escalation";
  const added = isRoleEscalation ? escalationAdds(a) : [];

  return (
    <div className="space-y-2">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Approval required"
        data-approval-id={a.id}
        tabIndex={-1}
        className={`sa-scroll max-h-[70dvh] overflow-y-auto rounded-xl border border-sa-line-strong border-l-4 ${style.border} bg-sa-raised p-3 outline-none sm:p-4`}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <ShieldAlert className={`h-4 w-4 shrink-0 ${style.text}`} />
          <span className="text-sm font-semibold text-sa-fg">{isRoleEscalation ? "Role escalation approval" : "Approval needed"}</span>
          <span className="sr-only">Approval required</span>
          <span className={`rounded-full px-2 py-0.5 font-mono text-[12px] font-semibold uppercase tracking-[0.1em] ${style.badge}`}>
            {meter.tier === "high" ? "High risk" : meter.label}
          </span>
          <span className="font-mono text-[12px] text-white/40">{a.tool}</span>
          <div className="ml-auto flex items-center gap-2" aria-label={`Risk meter: ${meter.segments} of 3`}>
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((i) => (
                <span
                  key={i}
                  data-risk-segment={i <= meter.segments ? "on" : "off"}
                  className={`h-1.5 w-5 rounded-full ${i <= meter.segments ? style.segmentOn : "bg-white/10"}`}
                />
              ))}
            </div>
            {countdown !== undefined && (
              <span data-approval-countdown={a.id} className={`font-mono text-[12px] ${expired ? "text-rose-300/90" : "text-white/60"}`}>
                {expired ? "expired" : `auto-denies in ${countdown}`}
              </span>
            )}
          </div>
        </div>

        {isRoleEscalation ? (
          <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/30 p-3" data-testid="role-escalation-detail">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-white/80">
              <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-medium">{a.fromRole?.name ?? a.fromRole?.id ?? "current role"}</span>
              <span aria-hidden className="text-white/35">→</span>
              <span className="rounded-md bg-indigo-400/15 px-2 py-0.5 font-medium text-indigo-200">{a.toRole?.name ?? a.toRole?.id ?? "requested role"}</span>
            </div>
            {added.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-[12px] uppercase tracking-wider text-white/35">This adds</div>
                <div className="flex flex-wrap gap-1.5">
                  {added.map((label) => (
                    <span key={label} className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[12px] text-amber-200/90">
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : a.action !== "" && (
          <div className="relative mt-3">
            <div className="mb-1 text-[12px] uppercase tracking-wider text-white/35">Command</div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/45 py-2 pl-3 pr-12 font-mono text-[12px] leading-relaxed text-amber-200/90 sm:max-h-40">
              {a.action}
            </pre>
            <button
              type="button"
              onClick={() => copyAction(a)}
              aria-label={copiedId === a.id ? "Copied" : "Copy command"}
              title="Copy command"
              className="absolute right-1.5 top-6 grid h-7 w-7 place-items-center rounded-lg border border-zinc-700/60 bg-zinc-800/80 text-zinc-300 transition hover:bg-zinc-700/80 hover:text-white"
            >
              {copiedId === a.id ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}

        {cwd ? (
          <div className="mt-2 text-xs text-white/55">
            <span className="text-white/35">Working dir: </span>
            <span className="font-mono">{String(cwd)}</span>
          </div>
        ) : null}
        {a.reason !== "" && (
          <div className="mt-2 text-xs text-white/55">
            <span className="text-white/35">Why: </span>{a.reason}
          </div>
        )}
        <div className="mt-1 text-xs text-white/55">
          <span className="text-white/35">Impact: </span>{String(impact)}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyId != null}
            onClick={() => decide(a, "deny")}
            className="order-2 rounded-lg border border-rose-500/50 bg-transparent px-3 h-8 text-[13px] font-medium text-rose-300 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50 sm:order-1 sm:px-4"
          >
            Deny <span className="ml-1 text-rose-300/50">(D)</span>
          </button>
          <button
            type="button"
            disabled={busyId != null}
            onClick={() => decide(a, "approve")}
            aria-label="Allow approval (A)"
            className="order-1 rounded-lg bg-indigo-500 px-4 h-8 text-[13px] font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 sm:order-2"
          >
            {isRoleEscalation ? "Allow escalation" : "Approve"} <span className="ml-1 text-white/60">(A)</span>
          </button>
          {!isRoleEscalation && (<button
            type="button"
            disabled={busyId != null}
            onClick={() => approveAlways(a)}
            className="order-3 flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 h-8 text-[13px] font-medium text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Always allow for this run <span className="text-white/40">(Shift+A)</span>
          </button>)}
          {busyId === a.id && <span className="font-mono text-[12px] text-white/40">sending…</span>}
        </div>
        {error && <div className="mt-2 font-mono text-[12px] text-rose-300/90">{error}</div>}
      </div>

      {visible.length > 1 && (
        <div className="font-mono text-[12px] text-white/35">+{visible.length - 1} more pending approval{visible.length > 2 ? "s" : ""}</div>
      )}
    </div>
  );
}

export default ApprovalGate;
