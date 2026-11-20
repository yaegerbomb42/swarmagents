import { useEffect, useState } from 'react';

type StorageKind = 'local' | 'session';

function storageFor(kind: StorageKind): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  return kind === 'local' ? window.localStorage : window.sessionStorage;
}

function useStored<T>(kind: StorageKind, key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = storageFor(kind)?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      storageFor(kind)?.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [kind, key, v]);
  return [v, setV] as const;
}

export function usePersisted<T>(key: string, initial: T) {
  return useStored('local', key, initial);
}

/** Like usePersisted, but scoped to the browser tab/session. */
export function useSessionPersisted<T>(key: string, initial: T) {
  return useStored('session', key, initial);
}
