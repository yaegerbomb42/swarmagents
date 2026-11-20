'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ensureAuthListener, fetchMe, waitForFirebaseUser } from '@/lib/auth';
import { isFirebaseConfigured } from '@/lib/firebase';

export type RequireAuthState = 'checking' | 'authed' | 'redirecting';

/**
 * Client-side route guard. Waits for Firebase to restore the persisted
 * session before treating a missing localStorage token as logged-out.
 */
export function useRequireAuth(redirectTo = '/login'): RequireAuthState {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<RequireAuthState>('checking');

  useEffect(() => {
    ensureAuthListener();
    let cancelled = false;
    (async () => {
      const firebaseUser = await waitForFirebaseUser();
      if (cancelled) return;
      // Unconfigured Firebase: the sandbox session (set by login()) is checked by fetchMe below.
      if (!firebaseUser && isFirebaseConfigured()) {
        setState('redirecting');
        router.replace(`${redirectTo}?next=${encodeURIComponent(pathname || '/')}`);
        return;
      }
      const me = await fetchMe();
      if (cancelled) return;
      if (!me.ok) {
        setState('redirecting');
        router.replace(`${redirectTo}?next=${encodeURIComponent(pathname || '/')}`);
        return;
      }
      setState('authed');
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, redirectTo, router]);

  return state;
}
