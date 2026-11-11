'use client';

import { useEffect, useState } from 'react';
import { ensureAuthListener, fetchMe, getStoredUser, getToken, type AuthUser } from '@/lib/auth';
import { isFirebaseConfigured } from '@/lib/firebase';

/**
 * Returns the currently signed-in Firebase user, or null when signed out.
 *
 * Reads the localStorage-backed session synchronously on first render (the
 * same cache SiteHeader and other console components use), then re-validates
 * it via fetchMe() once the auth listener is attached. Never throws in
 * environments where Firebase is not configured (SSR, tests, landing demo).
 */
export function useCurrentUser(): AuthUser | null {
  const [user, setUser] = useState<AuthUser | null>(() => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
    try {
      return getToken() ? getStoredUser() : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    ensureAuthListener();
    let cancelled = false;

    // Sync with whatever the cached session says right now
    let cached: AuthUser | null = null;
    try {
      cached = getToken() ? getStoredUser() : null;
    } catch {
      cached = null;
    }
    setUser(cached);

    // Re-validate against Firebase (skipped when Firebase is unconfigured)
    if (isFirebaseConfigured()) {
      fetchMe()
        .then((res) => {
          if (!cancelled) setUser(res.ok ? res.data : null);
        })
        .catch(() => {
          if (!cancelled) setUser(cached);
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return user;
}
