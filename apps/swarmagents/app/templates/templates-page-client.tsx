"use client";

/**
 * The /templates page.
 *
 * The gallery itself lives in minimalist-ui/src/components/TemplateCatalog.tsx
 * so the same component can be shown on the empty workspace. This wrapper
 * supplies the page-level chrome and the "run it" behaviour: the run is
 * started on the server (so the template's role applies), and the browser
 * then goes to the workspace to watch it.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { TemplateCatalog } from "../../minimalist-ui/src/components/TemplateCatalog";
import type { TaskTemplate } from "../../lib/templates/types";

function seedWorkspaceConversationKey(runId: string): boolean {
  try {
    window.localStorage.setItem("sa.thread", JSON.stringify(runId));
    return true;
  } catch {
    return false;
  }
}

export function TemplatesPageClient() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);

  const onRun = useCallback(
    async (template: TaskTemplate, values: Record<string, string>) => {
      setStarting(true);
      try {
        const res = await fetch("/api/templates/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId: template.id, values }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Could not start the run (HTTP ${res.status}).`);
        }
        const body = (await res.json().catch(() => null)) as { runId?: unknown } | null;
        const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
        if (!runId) throw new Error("The run started, but the server sent no run id.");
        seedWorkspaceConversationKey(runId);
        router.push(`/?run=${encodeURIComponent(runId)}`);
        setStarting(false);
      } catch (err) {
        setStarting(false);
        throw err;
      }
    },
    [router],
  );

  return (
    <main className="min-h-dvh bg-[#07070a] text-white antialiased">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 pt-6 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Workspace
        </Link>
        <p className="font-mono text-sm font-semibold tracking-tight">
          swarmagents<span className="text-cyan-400">.codes</span>
        </p>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/70">
          Template gallery
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          60 ready-made tasks, already written out
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
          Pick a task, fill in the few blanks, and the agent runs it on your own Linux
          computer with the role that suits the work. Every prompt is written in full —
          you are choosing the shape of the job, not writing it from scratch.
        </p>

        {starting && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-200">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Starting the run…
          </p>
        )}

        <div className="mt-8">
          <TemplateCatalog onRun={onRun} />
        </div>
      </div>
    </main>
  );
}
