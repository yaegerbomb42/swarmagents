'use client';

import { useEffect } from 'react';

// ════════════════════════════════════════════════════════════
//  GlobalError — last-resort boundary when the root layout
//  itself throws. Must render its own <html>/<body>; keeps the
//  dark theme so the failure never flashes a white screen.
//  Navigation here is a plain anchor: the router may be dead.
// ════════════════════════════════════════════════════════════

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    void import('@sentry/nextjs')
      .then((Sentry) => Sentry.captureException(error))
      .catch(() => {
        /* telemetry unavailable — boundary stays self-sufficient */
      });
  }, [error]);

  return (
    <html lang="en" className="bg-[#050508]">
      <body className="min-h-screen bg-[#050508] text-zinc-100 antialiased flex flex-col items-center justify-center p-6 text-center">
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center"
        >
          <span className="mb-4 px-2 py-0.5 rounded border border-red-400/30 bg-red-400/10 text-[10px] font-mono uppercase tracking-[0.14em] text-red-400">
            Fatal — root layout
          </span>
          <h1 className="text-2xl font-semibold mb-3">The app failed to start</h1>
          <p className="text-sm text-zinc-400 max-w-md mb-2 break-words">
            {error.message || 'An unexpected error occurred while loading the application shell.'}
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
            {/* Full reload on purpose — the client router is not trusted here. */}
            <a
              href="/"
              className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 text-sm hover:bg-white/[0.05] transition"
            >
              Reload app
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
