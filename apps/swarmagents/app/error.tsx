"use client";

import Link from "next/link";

/**
 * Root error boundary. Next.js renders this when any route in the app router
 * throws during render. The visitor gets a plain recovery path; the error
 * detail is never shown on the page because it is not actionable to them.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center bg-[#07070a] px-4 text-center text-white antialiased"
      data-digest={error.digest}
    >
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
        Something went wrong
      </p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
        We couldn&rsquo;t load this page.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-white/50">
        Try again, or head back to your workspace.
      </p>
      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          Back to the workspace
        </Link>
      </div>
    </main>
  );
}
