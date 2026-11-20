/**
 * Per-user cache of lens answers.
 *
 * A lens is deterministic enough for the same message to be worth reusing:
 * the cache is keyed by the message hash plus the lens id, so picking
 * "ELI5" twice on the same message never costs a second provider call.
 *
 * The cache lives in the user's own directory (next to their providers), so
 * one account never sees another account's lens answers.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { userProviderDir, type DataDirOptions } from "../providers/store";
import type { ReferencedFile } from "./prompts";
import type { LensId } from "./types";

/** File name of the per-user lens cache inside the user's directory. */
export const LENS_CACHE_FILE = "lenses.json";

/** Most answers kept per user; the oldest are dropped first. */
export const MAX_LENS_CACHE_ENTRIES = 200;

export interface LensCacheEntry {
  lens: LensId;
  text: string;
  provider: string;
  model: string;
  costUsd: number | null;
  latencyMs: number;
  createdAt: number;
}

interface LensCacheFile {
  version: number;
  entries: Record<string, LensCacheEntry>;
}

function emptyFile(): LensCacheFile {
  return { version: 1, entries: {} };
}

/** Path of the cache file for one user. */
export function lensCacheFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userProviderDir(userId, options), LENS_CACHE_FILE);
}

/**
 * The parts of a lens call beyond the message text that change the answer:
 * the run the message belongs to (its files may differ) and the files the
 * lens read alongside the message.
 */
export interface LensCacheContext {
  runId?: string;
  files?: readonly ReferencedFile[];
}

/**
 * Cache key for one (message, lens, run, files) tuple. The message and each
 * file's path + contents are hashed so the file never holds the message
 * itself, and the same message with different workspace files never returns
 * a stale cached answer.
 */
export function lensCacheKey(message: string, lens: LensId, context?: LensCacheContext): string {
  const hash = createHash("sha256");
  hash.update(message);
  if (context?.runId) hash.update(`\0run:${context.runId}`);
  for (const file of context?.files ?? []) {
    hash.update(`\0file:${file.path}\0`);
    hash.update(file.content);
  }
  return `${lens}:${hash.digest("hex").slice(0, 32)}`;
}

/** Read the user's cache. A missing or broken file reads as empty. */
export function readLensCache(userId: string, options: DataDirOptions = {}): LensCacheFile {
  try {
    const file = lensCacheFilePath(userId, options);
    if (!fs.existsSync(file)) return emptyFile();
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<LensCacheFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object" || !parsed.entries) {
      return emptyFile();
    }
    return { version: 1, entries: parsed.entries as Record<string, LensCacheEntry> };
  } catch {
    return emptyFile();
  }
}

/** One cached answer, or undefined when this (message, lens) was never run. */
export function getCachedLens(
  userId: string,
  key: string,
  options: DataDirOptions = {},
): LensCacheEntry | undefined {
  const entry = readLensCache(userId, options).entries[key];
  if (!entry || typeof entry.text !== "string" || !entry.text.trim()) return undefined;
  return entry;
}

/**
 * Store one answer. Writes are atomic (temp file + rename) and the file is
 * only readable by its owner. Best effort: a failed write only costs a
 * repeated provider call later.
 */
export function writeLensCacheEntry(
  userId: string,
  key: string,
  entry: LensCacheEntry,
  options: DataDirOptions = {},
): void {
  try {
    const cache = readLensCache(userId, options);
    cache.entries[key] = entry;
    const entries = Object.entries(cache.entries);
    if (entries.length > MAX_LENS_CACHE_ENTRIES) {
      entries.sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
      cache.entries = Object.fromEntries(entries.slice(0, MAX_LENS_CACHE_ENTRIES));
    }
    const dir = userProviderDir(userId, options);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = lensCacheFilePath(userId, options);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cache) + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* a broken cache must never break a lens */
  }
}
