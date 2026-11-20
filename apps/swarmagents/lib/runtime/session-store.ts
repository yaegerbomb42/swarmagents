import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStoragePaths } from "../board/store";

let SESSION_PATH: string | null = null;

export function configureSessionPaths(filePath: string): void {
  SESSION_PATH = filePath;
}

export function getSessionStorePath(): string {
  if (SESSION_PATH) return SESSION_PATH;
  const { STORAGE_DIR } = getStoragePaths();
  return path.join(STORAGE_DIR, "session_store.json");
}

export interface UserSessionStore {
  [userId: string]: string;
}

const FORBIDDEN_USER_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function isForbiddenUserId(userId: string): boolean {
  return FORBIDDEN_USER_IDS.has(userId);
}

function createEmptyStore(): UserSessionStore {
  return Object.create(null) as UserSessionStore;
}

/**
 * Serializes read-modify-write cycles within this process. The store is a
 * single JSON file, so two concurrent writers would otherwise both load the
 * same snapshot and the last rename would drop the other's update.
 */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>((res) => {
      resolve = res;
    });
    await release;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

const storeLock = new AsyncLock();

async function mutateSessionStore(mutate: (store: UserSessionStore) => void): Promise<void> {
  await storeLock.acquire(async () => {
    const store = loadSessionStore();
    mutate(store);
    await saveSessionAtomic(store);
  });
}

export function loadSessionStore(): UserSessionStore {
  const file = getSessionStorePath();
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const store = createEmptyStore();
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string" && !isForbiddenUserId(k)) store[k] = v;
        }
        return store;
      }
    }
  } catch {
    // ignore parse errors, return empty store
  }
  return createEmptyStore();
}

function sanitizeStore(store: UserSessionStore): UserSessionStore {
  const clean = createEmptyStore();
  for (const [k, v] of Object.entries(store)) {
    if (typeof v === "string" && !isForbiddenUserId(k)) clean[k] = v;
  }
  return clean;
}

export async function saveSessionAtomic(store: UserSessionStore): Promise<void> {
  const file = getSessionStorePath();
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  // randomUUID (not just pid+ms): two concurrent saves in the same
  // millisecond must not collide on the temp name and lose a rename.
  const tmp = `${file}.tmp.${Date.now()}.${process.pid}.${randomUUID()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(sanitizeStore(store), null, 2) + "\n", "utf-8");
  await fs.promises.rename(tmp, file);
}

export function getLastSession(userId: string): string | undefined {
  if (isForbiddenUserId(userId)) return undefined;
  const store = loadSessionStore();
  return store[userId];
}

export async function setLastSession(userId: string, sessionId: string): Promise<void> {
  if (isForbiddenUserId(userId)) {
    throw new Error(`Refusing to store session for forbidden userId: ${userId}`);
  }
  await mutateSessionStore((store) => {
    store[userId] = sessionId;
  });
}

export async function clearLastSession(userId: string): Promise<void> {
  if (isForbiddenUserId(userId)) return;
  await mutateSessionStore((store) => {
    delete store[userId];
  });
}
