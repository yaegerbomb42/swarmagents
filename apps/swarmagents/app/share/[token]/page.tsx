import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSharedProject } from "../../../lib/projects/store";
import { DesktopReplay } from "../../../minimalist-ui/src/components/DesktopReplay";
import { SharedReportCard } from "../../../minimalist-ui/src/components/SharedReportCard";
import { LiveRoomClient } from "./live-room-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Shared project · SwarmAgents",
  robots: { index: false, follow: false },
};

function when(ts: number): string {
  if (!ts) return "unknown";
  try {
    return new Date(ts).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "unknown";
  }
}

export default async function SharedProjectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const project = getSharedProject(token);
  if (!project) notFound();

  return (
    <main className="min-h-dvh bg-[#07070a] px-4 py-10 text-white sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-xs tracking-[0.14em] text-cyan-300/80">SWARMAGENTS · SHARED PROJECT</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{project.name}</h1>
            <p className="mt-1 text-sm text-white/50">
              Read-only snapshot. The owner can revoke this link at any time; nothing here can run or change the
              project.
            </p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Open SwarmAgents
          </Link>
        </header>

        <LiveRoomClient token={token} />

        {project.showcase && (
          <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Replay showcase</h2>
            <p className="mt-1 text-sm text-white/50">
              A finished run the owner chose to feature — scrub through the recorded desktop, then try the same
              prompt in your own workspace.
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/40">
              <DesktopReplay
                runId={project.showcase.runId}
                url={`/api/share/${encodeURIComponent(token)}/replay`}
              />
            </div>
            <div className="mt-4">
              <SharedReportCard showcase={project.showcase} />
            </div>
            <div className="mt-4">
              <Link
                href={`/?prompt=${encodeURIComponent(project.showcase.prompt)}`}
                className="inline-flex items-center gap-2 rounded-full bg-cyan-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-cyan-400"
              >
                Try this prompt →
              </Link>
              <p className="mt-2 text-[11px] text-white/30">
                Opens SwarmAgents with the prompt pre-filled; it runs in your own account and VM, not the owner&apos;s.
              </p>
            </div>
          </section>
        )}

        <section className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[10px] uppercase tracking-wide text-white/40">Repo</p>
            <p className="mt-1 break-all text-sm text-white/85">{project.repo ?? "—"}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[10px] uppercase tracking-wide text-white/40">Branch</p>
            <p className="mt-1 break-all font-mono text-sm text-white/85">{project.activeBranch ?? "—"}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[10px] uppercase tracking-wide text-white/40">Updated</p>
            <p className="mt-1 text-sm text-white/85">{when(project.updatedAt)}</p>
          </div>
        </section>

        <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Resume state</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-white/35">Open files</p>
              {project.openFiles.length === 0 ? (
                <p className="mt-1 text-sm text-white/40">No files recorded.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {project.openFiles.slice(0, 12).map((file) => (
                    <li key={file} className="break-all font-mono text-[12px] text-white/70">
                      {file}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-white/35">Last test</p>
              {project.lastTest ? (
                <div className="mt-1 space-y-1">
                  <p className="break-all font-mono text-[12px] text-white/70">{project.lastTest.command}</p>
                  <p className={project.lastTest.ok ? "text-[12px] text-emerald-300" : "text-[12px] text-rose-300"}>
                    {project.lastTest.ok ? "passing" : "failing"} · exit {project.lastTest.exitCode}
                    {project.lastTest.passed !== undefined ? ` · ${project.lastTest.passed} passed` : ""}
                    {project.lastTest.failed !== undefined ? ` · ${project.lastTest.failed} failed` : ""}
                  </p>
                  {project.lastTest.failing.map((failure) => (
                    <p key={failure} className="break-all font-mono text-[11px] text-rose-300/80">
                      {failure}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm text-white/40">No test run recorded.</p>
              )}
            </div>
          </div>
        </section>

        <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">
            Recent commands ({project.commands.length})
          </h2>
          {project.commands.length === 0 ? (
            <p className="mt-2 text-sm text-white/40">No commands recorded.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {project.commands.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex items-start gap-2">
                  <span
                    className={`mt-px shrink-0 rounded-full border px-1.5 py-px font-mono text-[10px] ${
                      entry.exitCode === 0
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                        : "border-rose-400/30 bg-rose-400/10 text-rose-300"
                    }`}
                  >
                    exit {entry.exitCode}
                  </span>
                  <code className="min-w-0 break-all font-mono text-[12px] text-white/70">{entry.command}</code>
                </li>
              ))}
            </ul>
          )}
        </section>

        {project.pinnedNotes.length > 0 && (
          <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Pinned notes</h2>
            <ul className="mt-2 space-y-1.5">
              {project.pinnedNotes.map((note) => (
                <li key={note} className="text-sm text-white/70">
                  {note}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-6 text-[11px] text-white/30">
          {project.threadCount} thread{project.threadCount === 1 ? "" : "s"} in this project · shared{" "}
          {when(project.sharedAt)} · secrets and environment variables are never included.
        </footer>
      </div>
    </main>
  );
}
