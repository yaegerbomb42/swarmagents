import type { Metadata } from "next";
import Link from "next/link";
import { deepHealthSnapshot } from "@/lib/health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status — SwarmAgents",
  description: "Public health summary for this SwarmAgents deployment.",
};

function formatUptime(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const parts = [`${Math.floor(hours / 24)}d`];
  const restHours = hours % 24;
  const restMinutes = minutes % 60;
  if (restHours > 0) parts.push(`${restHours}h`);
  if (restMinutes > 0) parts.push(`${restMinutes}m`);
  return parts.join(" ");
}

/**
 * Public status page: a plain-language summary built from the same
 * liveness signal as GET /api/health. Counts and booleans only — no key
 * values, no paths, nothing that could aid an attacker.
 */
export default function StatusPage() {
  const health = deepHealthSnapshot(process.env);

  const rows: { label: string; value: string; ok: boolean | null }[] = [
    {
      label: "Service",
      value: health.ok ? "Operational" : "Degraded — storage unavailable",
      ok: health.ok,
    },
    {
      label: "Version",
      value: `v${health.version}${health.commit !== "unknown" ? ` · ${health.commit.slice(0, 7)}` : ""}`,
      ok: null,
    },
    {
      label: "Uptime",
      value: formatUptime(health.uptimeSec),
      ok: null,
    },
    {
      label: "VM driver",
      value: health.vmDriver === "none" ? "Not configured" : `${health.vmDriver}${health.subsystems.desktopEnabled ? " · Desktop GUI" : ""}`,
      ok: health.vmDriver === "none" ? null : true,
    },
    {
      label: "Verified MCP connectors",
      value: `${health.subsystems.catalogConnectorCount} ready in hub`,
      ok: health.subsystems.catalogConnectorCount >= 40,
    },
    {
      label: "Capability Atlas & Tool Forge",
      value: health.subsystems.atlasReady && health.subsystems.toolForgeReady ? "Active (zero-bloat search + self-authoring)" : "Unavailable",
      ok: health.subsystems.atlasReady && health.subsystems.toolForgeReady,
    },
    {
      label: "Desktop mode",
      value: health.desktopEnabled ? "Enabled — desktop VM image" : "Off — headless VM image",
      ok: health.desktopEnabled ? true : null,
    },
    {
      label: "Connector catalog",
      value: `${health.catalogConnectorCount} connector${health.catalogConnectorCount === 1 ? "" : "s"} available`,
      ok: health.catalogConnectorCount > 0 ? true : null,
    },
    {
      label: "Providers configured",
      value:
        health.providersScope === "user"
          ? `${health.providersConfigured} for your account`
          : health.providersConfigured > 0
            ? `${health.providersConfigured} host key(s) present`
            : "None — configure a provider to run",
      ok: null,
    },
  ];

  const subsystems: { label: string; value: string; ok: boolean; note: string }[] = [
    {
      label: "Capability atlas",
      value: health.atlasReady ? "Ready" : "Off",
      ok: health.atlasReady,
      note: "Opt-in MCP server (SWARM_ATLAS_ENABLED=1)",
    },
    {
      label: "Tool forge",
      value: health.toolForgeReady ? "Ready" : "Unavailable",
      ok: health.toolForgeReady,
      note: "MCP tool library that assembles run tooling",
    },
  ];

  return (
    <main className="min-h-dvh bg-[#07070a] text-white antialiased">
      <div className="mx-auto max-w-2xl px-5 py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/70">
          SwarmAgents
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Status</h1>
        <p className="mt-2 text-sm text-white/50">
          Live health summary for this deployment, refreshed on every visit.
        </p>

        <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl shadow-[0_24px_70px_-25px_rgba(0,0,0,0.85)]">
          <div
            className={`flex items-center gap-2.5 px-5 py-4 text-sm font-medium ${
              health.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${health.ok ? "bg-emerald-400" : "bg-amber-400"}`}
            />
            {health.ok ? "All systems operational" : "Service degraded"}
          </div>
          <dl className="divide-y divide-white/5 bg-white/[0.02]">
            {rows.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-4 px-5 py-3.5">
                <dt className="text-xs uppercase tracking-widest text-white/40">{row.label}</dt>
                <dd className="flex items-center justify-end gap-2 text-right text-sm text-white/85">
                  {row.ok !== null && (
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${row.ok ? "bg-emerald-400/70" : "bg-amber-400/70"}`}
                    />
                  )}
                  <span>{row.value}</span>
                  {row.ok !== null && <span className="sr-only">{row.ok ? "OK" : "Needs attention"}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl ring-1 ring-white/10">
          <div className="border-b border-white/5 bg-white/[0.03] px-5 py-3">
            <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-white/50">
              Harness subsystems
            </h2>
          </div>
          <dl className="divide-y divide-white/5 bg-white/[0.02]">
            {subsystems.map((sub) => (
              <div key={sub.label} className="flex items-baseline justify-between gap-4 px-5 py-3.5">
                <dt>
                  <span className="block text-xs uppercase tracking-widest text-white/40">{sub.label}</span>
                  <span className="mt-0.5 block text-[11px] text-white/35">{sub.note}</span>
                </dt>
                <dd className="flex items-center justify-end gap-2 text-right text-sm text-white/85">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${sub.ok ? "bg-emerald-400/70" : "bg-white/25"}`}
                  />
                  <span>{sub.value}</span>
                  <span className="sr-only">{sub.ok ? "OK" : "Off"}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-white/40">
          This is a summary only. Machine-readable signals live at{" "}
          <a href="/api/health" className="font-mono text-cyan-300 hover:text-cyan-200">
            /api/health
          </a>{" "}
          and{" "}
          <a href="/api/health?deep=1" className="font-mono text-cyan-300 hover:text-cyan-200">
            /api/health?deep=1
          </a>
          .
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-white/10 pt-6 text-xs text-white/40">
          <Link href="/" className="text-cyan-300 hover:text-cyan-200">
            ← Back to the console
          </Link>
          <Link href="/connectors" className="text-white/60 hover:text-white">
            Connector Hub
          </Link>
          <Link href="/providers" className="text-white/60 hover:text-white">
            Providers
          </Link>
        </div>
      </div>
    </main>
  );
}
