/**
 * Shared Memory — Simple in-memory key-value store for agent state.
 */

const store = new Map<string, unknown>();

export function getSharedMemory() {
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => store.set(key, value),
    has: async (key: string) => store.has(key),
    delete: async (key: string) => store.delete(key),
    keys: async () => Array.from(store.keys()),
  };
}
