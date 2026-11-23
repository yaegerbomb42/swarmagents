"use client";

/**
 * /library — the full-page Library.
 *
 * The workspace drawer shows the same component embedded. This page is the
 * deep-linkable view for browsing the public catalog, publishing, and
 * managing what this account has installed.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LibraryView } from "../../minimalist-ui/src/components/LibraryView";

export default function LibraryPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-[#07070a] text-white antialiased">
      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2.5 px-4 pt-6 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Workspace
        </Link>
        <p className="mr-2 font-mono text-sm font-semibold tracking-tight">
          swarmagents<span className="text-cyan-400">.codes</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href="/connectors"
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Connectors
          </Link>
          <Link
            href="/providers"
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Providers
          </Link>
          <Link
            href="/library"
            aria-current="page"
            className="rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1 text-xs font-medium text-cyan-200"
          >
            Library
          </Link>
        </div>
      </header>
      <div className="mx-auto mt-6 flex min-h-0 w-full max-w-6xl flex-1 flex-col px-4 pb-10 sm:px-8">
        <div className="flex min-h-[70vh] flex-1 overflow-hidden rounded-2xl border border-white/10 bg-[#08080c]">
          <LibraryView />
        </div>
      </div>
    </main>
  );
}
