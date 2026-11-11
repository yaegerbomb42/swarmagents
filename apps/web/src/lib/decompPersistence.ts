/**
 * Persist active decomp session id per signed-in user (browser + server restore).
 */

import { getStoredUser } from '@/lib/auth';

const KEY_PREFIX = 'decomp_active_session:';
const LEGACY_KEY = 'decomp_active_session';

function storageKey(userId?: string | null): string {
  return userId ? `${KEY_PREFIX}${userId}` : LEGACY_KEY;
}

export function rememberActiveDecompSession(sessionId: string, userId?: string | null): void {
  if (typeof window === 'undefined' || !sessionId) return;
  const uid = userId || getStoredUser()?.id || null;
  try {
    localStorage.setItem(storageKey(uid), sessionId);
    if (uid) localStorage.setItem(LEGACY_KEY, sessionId);
  } catch {
    /* private mode */
  }
}

export function readActiveDecompSessionId(userId?: string | null): string | null {
  if (typeof window === 'undefined') return null;
  const uid = userId || getStoredUser()?.id || null;
  try {
    return (
      localStorage.getItem(storageKey(uid)) ||
      localStorage.getItem(LEGACY_KEY) ||
      null
    );
  } catch {
    return null;
  }
}

export function clearActiveDecompSession(userId?: string | null): void {
  if (typeof window === 'undefined') return;
  const uid = userId || getStoredUser()?.id || null;
  try {
    localStorage.removeItem(storageKey(uid));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
