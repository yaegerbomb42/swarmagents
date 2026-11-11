'use client';

import type { ReactNode } from 'react';
import { useRequireAuth } from '@/hooks/useRequireAuth';

/**
 * Client-side route guard for console pages.
 * Redirects to /login when no valid Firebase session exists.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const state = useRequireAuth();

  if (state !== 'authed') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-cyan-100/45">
        {state === 'checking' ? 'Checking session…' : 'Redirecting to sign in…'}
      </div>
    );
  }

  return <>{children}</>;
}
