'use client';

import { useEffect } from 'react';
import Link from 'next/link';

// ════════════════════════════════════════════════════════════
//  RouteError — app-level error boundary (Linear-grade, dark)
//  Catches render errors in any route segment below the root
//  layout and offers in-place recovery instead of the default
//  Next.js error screen. Telemetry is best-effort: reporting
//  failures must never break the recovery UI.
// ════════════════════════════════════════════════════════════

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RouteError({ error, reset }: RouteErrorProps) {
  useEffect(() => {
    // Fire-and-forget capture; never blocks or breaks recovery.
    void import('@sentry/nextjs')
      .then((Sentry) => Sentry.captureException(error))
      .catch(() => {
        /* telemetry unavailable — boundary stays self-sufficient */
      });
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="min-h-[60vh] flex flex-col items-center justify-center bg-[#09090b] text-zinc-100 p-6 text-center"
    >
      <span className="mb-4 px-2 py-0.5 rounded border border-cyan-400/30 bg-cyan-400/10 text-[10px] font-mono uppercase tracking-[0.14em] text-cyan-400">
        Render fault — route segment
      </span>
      <h1 className="text-2xl font-semibold mb-3">Something went wrong</h1>
      <p className="text-sm text-zinc-400 max-w-md mb-2 break-words">
        {error.message || 'An unexpected error occurred while rendering this page.'}
      </p>
      {error.digest ? (
        <p className="text-[10px] font-mono text-zinc-600 mb-6" style={{ fontVariantNumeric: 'tabular-nums' }}>
          digest {error.digest}
        </p>
      ) : (
        <div className="mb-6" />
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          autoFocus
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-cyan-500 text-black font-semibold text-sm hover:bg-cyan-400 transition"
        >
          Try again
        </button>
        <Link
          href="/"
          className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 text-sm hover:bg-white/[0.05] transition"
        >
          Return to Home
        </Link>
      </div>
    </div>
  );
}
