"use client";

/**
 * Design review surface (`/design`).
 *
 * Renders the primitives this PR lifts out of the three attached prototypes, on
 * top of SwarmAgents' own tokens, using *this* deployment's real capability
 * signals. Nothing here is a mock: the capability cards read `/api/health`, so
 * the page doubles as an honest statement of what this build can do.
 *
 * It exists so the design can be reviewed live before any product surface is
 * migrated onto it.
 */

import { useEffect, useMemo, useState } from "react";
import {
  CapabilityCard,
  Card,
  EmptyState,
  EventList,
  GateButton,
  MicroLabel,
  SectionHeading,
  StatusPill,
  StepRail,
  type EventRowData,
} from "../../minimalist-ui/src/design/primitives";
import { deriveCapabilities, type CapabilitySignals } from "../../minimalist-ui/src/design/capabilities";
import { planProgressLabel, buildPlanSteps, type StepInput } from "../../minimalist-ui/src/design/steps";

const DEMO_STEPS: StepInput[] = [
  { title: "Read the failing test and the code it covers", detail: "tests/checkout.test.ts" },
  { title: "Fix the discount rounding", detail: "src/pricing.ts" },
  { title: "Run the suite and report", detail: "npm run test:unit" },
];

const DEMO_EVENTS: EventRowData[] = [
  { type: "run.started", time: "12:04:01", detail: "docker driver, claude-sonnet-4-5" },
  { type: "tool.call", time: "12:04:06", detail: "Read src/pricing.ts" },
  { type: "run.retry", time: "12:04:19", detail: "provider 429, backing off 2s" },
  { type: "approval.resolved", time: "12:04:31", detail: "approved by user" },
  { type: "run.failed", time: "12:05:02", detail: "exit code 1" },
];

export default function DesignPage() {
  const [signals, setSignals] = useState<CapabilitySignals>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Probe both: health for the deployment, and the agent route for the
    // capability this build may simply not have (a missing route is a 404, not
    // an error) — the page must not claim a capability it cannot prove.
    void Promise.all([
      fetch("/api/health", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/agents/harnesses", { cache: "no-store" })
        .then((res) => res.ok)
        .catch(() => false),
    ])
      .then(([body, agentsReady]) => {
        setSignals({
          vmDriver: (body as { vmDriver?: string } | null)?.vmDriver ?? null,
          providersConfigured: ((body as { providersConfigured?: number } | null)?.providersConfigured ?? 0) > 0,
          agentsEnabled: agentsReady === true,
        });
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const capabilities = useMemo(() => deriveCapabilities(signals), [signals]);
  const built = useMemo(() => buildPlanSteps(DEMO_STEPS, { currentIndex: 1 }), []);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-8 text-zinc-200">
      <header className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-px w-4 bg-white/40" />
          <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">Design system</span>
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.045em] text-white">
          Workspace primitives<span className="text-[color:var(--color-run)]">.</span>
        </h1>
        <p className="mt-2 max-w-[620px] text-[12.5px] leading-relaxed text-zinc-400">
          Lifted from the three attached prototypes: the step rail and event rows from the two autonomy dashboards, the
          capability gating from the universal computer platform, and the micro-label / hairline craft from all three. The
          palette stays SwarmAgents&apos; own.
        </p>
      </header>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <Card className="p-3">
          <SectionHeading title="Run plan" tag="STEP RAIL" right={<span className="font-mono">{planProgressLabel(built)}</span>} />
          <div className="mt-2">
            <StepRail steps={DEMO_STEPS} progress={{ currentIndex: 1 }} />
          </div>
        </Card>

        <Card className="p-3">
          <SectionHeading title="Run events" tag="ACTIVITY" right={<span className="font-mono">{DEMO_EVENTS.length}</span>} />
          <div className="mt-1">
            <EventList events={DEMO_EVENTS} />
          </div>
        </Card>

        <Card className="p-3">
          <SectionHeading title="Status" tag="PILLS" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusPill tone="running">running</StatusPill>
            <StatusPill tone="ok">completed</StatusPill>
            <StatusPill tone="warn">degraded</StatusPill>
            <StatusPill tone="err">failed</StatusPill>
            <StatusPill tone="neutral">queued</StatusPill>
          </div>
          <div className="mt-3">
            <MicroLabel right={<span className="text-[9px] text-zinc-600">requires → reason</span>}>Gated controls</MicroLabel>
            <div className="mt-2 flex flex-wrap gap-3">
              <GateButton capabilities={capabilities} requires="vm">
                Start a run
              </GateButton>
              <GateButton capabilities={capabilities} requires="desktop">
                Open desktop
              </GateButton>
            </div>
          </div>
        </Card>

        <Card className="p-3">
          <SectionHeading title="Empty state" tag="NO DATA" />
          <EmptyState kicker="Nothing running" title="No run yet" action={<StatusPill tone="neutral">idle</StatusPill>}>
            Start a run and the plan, events and approvals appear here. No placeholder data is shown.
          </EmptyState>
        </Card>
      </div>

      <section className="mt-5">
        <SectionHeading
          title="This deployment"
          tag="LIVE FROM /api/health"
          right={<span className="font-mono">{loaded ? "live" : "loading…"}</span>}
        />
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((capability) => (
            <CapabilityCard key={capability.id} capability={capability} />
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
          No simulated state: a capability this build cannot honour is reported as off, with the reason attached, instead
          of a control that looks pressable and does nothing.
        </p>
      </section>
    </main>
  );
}
