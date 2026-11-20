import type { Metadata } from "next";
import { healthSnapshot } from "@/lib/health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status — SwarmAgents",
  description: "Public health summary for this SwarmAgents deployment.",
};

/**
 * Public status page: a plain-language summary built from the same
 * liveness signal as GET /api/health. Counts and booleans only — no key
 * values, no paths, nothing that could aid an attacker.
 */
export default function StatusPage() {
  const health = healthSnapshot(process.env);

  const rows: { label: string; value: string; ok: boolean | null }[] = [
    {
      label: "Service",
      value: health.ok ? "Operational" : "Degraded — board storage is not writable",
      ok: health.ok,
    },
    {
      label: "Version",
      value: `v${health.version}${health.commit !== "unknown" ? ` · ${health.commit.slice(0, 7)}` : ""}`,
      ok: null,
    },
    {
      label: "Uptime",
      value: `${Math.floor(health.uptimeSec / 60)} min`,
      ok: null,
    },
    {
      label: "VM driver",
      value: health.vmDriver === "none" ? "Not configured" : health.vmDriver,
      ok: health.vmDriver === "none" ? null : true,
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

        <div className="mt-8 overflow-hidden rounded-2xl ring-1 ring-white/10">
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
                <dd className="text-right text-sm text-white/85">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-white/40">
          This is a summary only. The machine-readable signal lives at{" "}
          <a href="/api/health" className="font-mono text-cyan-300 hover:text-cyan-200">
            /api/health
          </a>
          .
        </p>
        <p className="mt-10 border-t border-white/10 pt-6 text-xs text-white/40">
          <a href="/" className="text-cyan-300 hover:text-cyan-200">
            ← Back to the console
          </a>
        </p>
      </div>
    </main>
  );
}
