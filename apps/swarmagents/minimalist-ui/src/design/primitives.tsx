"use client";

/**
 * Design primitives for the SwarmAgents workspace.
 *
 * Provenance matters here, because none of this was invented on the spot:
 *
 *  - The step rail (node + connector, numbered → check → cross) and the event
 *    rows come from `autonomous-ai-computer-platform` (globals.css `.plan-*`,
 *    `.event-*`) and `autonomous-human-ai-architecture` (Rail.tsx plan tab).
 *  - The capability cards and the "disabled with a reason" button come from
 *    `universal-autonomous-computer-platform`, whose refusal to fake an
 *    unavailable runtime is the single best idea in the three bundles.
 *  - The micro-label / hairline / tight type scale is the shared craft of all
 *    three; the palette stays SwarmAgents' own (black canvas, neon white), with
 *    the bundles' tinted status fills borrowed via the existing --color-* vars.
 *
 * Every primitive is inert: state comes from the caller, decisions come from
 * `capabilities.ts` / `steps.ts`, which are unit tested.
 */

import type { ReactNode } from "react";
import { capabilityTone, degradedHint, gate, type Capability, type CapabilityId } from "./capabilities";
import { buildPlanSteps, eventTone, stepGlyph, type PlanStep, type StepInput, type StepProgress } from "./steps";

const HAIRLINE = "border-white/[0.07]";
const CARD = `rounded-lg border ${HAIRLINE} bg-white/[0.02]`;

export function MicroLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[9px] font-bold uppercase tracking-[0.13em] text-zinc-500">{children}</span>
      {right}
    </div>
  );
}

export function SectionHeading({
  icon,
  title,
  tag,
  right,
}: {
  icon?: ReactNode;
  title: string;
  tag?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-[27px] items-center justify-between">
      <div className="flex items-center gap-2">
        {icon ? <span className="text-zinc-400">{icon}</span> : null}
        <h2 className="text-[13px] font-semibold leading-none tracking-[-0.015em] text-zinc-100">{title}</h2>
        {tag ? (
          <span className={`rounded-sm border ${HAIRLINE} bg-white/[0.03] px-1 py-[3px] text-[8px] font-bold tracking-[0.075em] text-zinc-500`}>
            {tag}
          </span>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">{right}</div> : null}
    </div>
  );
}

export type PillTone = "ok" | "warn" | "err" | "neutral" | "running";

const PILL: Record<PillTone, string> = {
  ok: "border-[color:var(--color-ok)]/40 bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]",
  warn: "border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]",
  err: "border-[color:var(--color-err)]/40 bg-[color:var(--color-err)]/10 text-[color:var(--color-err)]",
  neutral: "border-white/[0.10] bg-white/[0.04] text-zinc-400",
  running: "border-[color:var(--color-run)]/45 bg-[color:var(--color-run)]/12 text-[color:var(--color-run)]",
};

export function StatusPill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-[3px] text-[9px] font-semibold capitalize ${PILL[tone]}`}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${CARD} ${className}`}>{children}</div>;
}

/**
 * One rail node. `active` gets the filled accent node, `done` a check, `failed`
 * a cross — the same three states the bundled designs used, with the connector
 * line short enough that a short plan does not look like a timeline.
 */
export function StepNode({ step, index, last }: { step: PlanStep; index: number; last: boolean }) {
  const node =
    step.status === "active"
      ? "border-[color:var(--color-run)] bg-[color:var(--color-run)] text-black"
      : step.status === "done"
        ? "border-[color:var(--color-ok)]/60 bg-[color:var(--color-ok)]/15 text-[color:var(--color-ok)]"
        : step.status === "failed"
          ? "border-[color:var(--color-err)]/60 bg-[color:var(--color-err)]/15 text-[color:var(--color-err)]"
          : "border-white/[0.12] bg-white/[0.03] text-zinc-500";
  return (
    <li className="flex gap-2.5">
      <div className="flex w-[18px] flex-none flex-col items-center">
        <span className={`grid h-[17px] w-[17px] place-items-center rounded-full border text-[9px] font-semibold ${node}`}>
          {stepGlyph(step, index)}
        </span>
        {last ? null : <span className={`w-px flex-1 ${step.status === "done" ? "bg-[color:var(--color-ok)]/30" : "bg-white/[0.09]"}`} />}
      </div>
      <div className="min-w-0 pb-3">
        <strong
          className={`block text-[10.5px] font-semibold leading-snug ${
            step.status === "pending" ? "text-zinc-500" : "text-zinc-200"
          }`}
        >
          {step.title}
        </strong>
        {step.detail ? <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{step.detail}</p> : null}
      </div>
    </li>
  );
}

export function StepRail({
  steps,
  progress,
  emptyLabel = "No plan yet. The agent builds a checklist as it works.",
}: {
  steps: readonly StepInput[];
  progress: StepProgress;
  emptyLabel?: string;
}) {
  if (steps.length === 0) {
    return <p className="px-1 py-4 text-[11px] text-zinc-500">{emptyLabel}</p>;
  }
  const built = buildPlanSteps(steps, progress);
  return (
    <ol className="pt-1">
      {built.map((step, index) => (
        <StepNode key={`${index}-${step.title}`} step={step} index={index} last={index === built.length - 1} />
      ))}
    </ol>
  );
}

const EVENT_DOT: Record<ReturnType<typeof eventTone>, string> = {
  ok: "bg-[color:var(--color-ok)]/70 text-[color:var(--color-ok)]",
  warn: "bg-[color:var(--color-warn)]/70 text-[color:var(--color-warn)]",
  err: "bg-[color:var(--color-err)]/70 text-[color:var(--color-err)]",
  neutral: "bg-white/[0.14] text-zinc-400",
};

export interface EventRowData {
  type: string;
  time?: string;
  detail?: string;
}

export function EventRow({ event }: { event: EventRowData }) {
  const tone = eventTone(event.type);
  return (
    <li className="flex gap-2.5 py-1.5">
      <span className={`mt-[5px] h-[6px] w-[6px] flex-none rounded-full ${EVENT_DOT[tone]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <strong className="truncate text-[10.5px] font-medium text-zinc-300">{event.type}</strong>
          {event.time ? <span className="flex-none text-[9px] text-zinc-600">{event.time}</span> : null}
        </div>
        {event.detail ? <p className="mt-0.5 truncate text-[10px] text-zinc-500">{event.detail}</p> : null}
      </div>
    </li>
  );
}

export function EventList({ events, emptyLabel = "No events yet." }: { events: readonly EventRowData[]; emptyLabel?: string }) {
  if (events.length === 0) return <p className="px-1 py-3 text-[11px] text-zinc-600">{emptyLabel}</p>;
  return <ul className="divide-y divide-white/[0.04]">{events.map((event, i) => <EventRow key={`${event.type}-${i}`} event={event} />)}</ul>;
}

/**
 * Empty state with the radial "orbit" art the bundles used. The artwork is pure
 * CSS so it costs nothing and cannot fail to load.
 */
export function EmptyState({
  kicker,
  title,
  children,
  action,
}: {
  kicker: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <div className="relative mb-4 grid h-[66px] w-[66px] place-items-center rounded-2xl border border-white/[0.12] bg-white/[0.03] text-zinc-300">
        <span className="absolute inset-0 rounded-2xl shadow-[0_0_0_9px_rgba(255,255,255,0.025)]" aria-hidden />
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 4.5v15M4.5 12h15" strokeDasharray="2 3" />
        </svg>
      </div>
      <p className="text-[9px] font-bold uppercase tracking-[0.13em] text-zinc-500">{kicker}</p>
      <h3 className="mt-1.5 text-[15px] font-semibold tracking-[-0.02em] text-zinc-100">{title}</h3>
      {children ? <div className="mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-zinc-500">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * A control that knows whether the deployment can honour it.
 *
 * This is the piece worth taking from the first bundle: when the capability is
 * missing the button is disabled *and* carries the reason, in the `title` and
 * as visible text — a disabled control with no explanation is a dead end.
 */
export function GateButton({
  capabilities,
  requires,
  onClick,
  children,
  showReason = true,
}: {
  capabilities: readonly Capability[];
  requires: CapabilityId;
  onClick?: () => void;
  children: ReactNode;
  showReason?: boolean;
}) {
  const { disabled, reason } = gate(capabilities, requires);
  const hint = degradedHint(capabilities, requires);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={disabled ? reason : hint ?? undefined}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.18] bg-white/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-zinc-100 shadow-[inset_0_1px_rgba(255,255,255,0.06)] hover:bg-white/[0.11] disabled:cursor-not-allowed disabled:opacity-45"
      >
        {children}
      </button>
      {disabled && showReason ? <span className="max-w-[260px] text-[10px] leading-snug text-zinc-600">{reason}</span> : null}
      {!disabled && hint && showReason ? (
        <span className="max-w-[260px] text-[10px] leading-snug text-[color:var(--color-warn)]/80">{hint}</span>
      ) : null}
    </span>
  );
}

export function CapabilityCard({ capability }: { capability: Capability }) {
  const tone = capabilityTone(capability.state);
  return (
    <Card className="p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-zinc-200">{capability.label}</p>
        <StatusPill tone={tone === "ok" ? "ok" : tone === "warn" ? "warn" : "neutral"}>
          {capability.state === "unavailable" ? "off" : capability.state}
        </StatusPill>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">{capability.detail}</p>
    </Card>
  );
}
