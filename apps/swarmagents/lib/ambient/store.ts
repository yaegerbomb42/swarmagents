import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write";
import type { AmbientRule, PostedRunReport } from "./types";

function homeDir(): string {
  const home = process.env.SWARM_HOME?.trim();
  if (home) return home;
  return path.join(process.cwd(), ".swarm-ambient");
}

let rulesOverride: string | undefined;
let deliveriesOverride: string | undefined;

export function configureAmbientStore(dir: string): void {
  rulesOverride = path.join(dir, "ambient-rules.json");
  deliveriesOverride = path.join(dir, "ambient-deliveries.jsonl");
}

function rulesPath(): string {
  return rulesOverride ?? path.join(homeDir(), "ambient-rules.json");
}

function deliveriesPath(): string {
  return deliveriesOverride ?? path.join(homeDir(), "ambient-deliveries.jsonl");
}

function isRule(value: unknown): value is AmbientRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as AmbientRule;
  return typeof rule.id === "string" && typeof rule.userId === "string" && typeof rule.roleId === "string";
}

export function loadRules(): AmbientRule[] {
  try {
    const raw = fs.readFileSync(rulesPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRule);
  } catch {
    return [];
  }
}

/**
 * Rules can carry webhook secrets, so the file is owner-only (0o600) in an
 * owner-only directory, and is replaced atomically (temp + fsync + rename).
 */
export function saveRules(rules: AmbientRule[]): void {
  const file = rulesPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(file, JSON.stringify(rules, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    // The temp file is created with 0o600, but a umask or a pre-existing
    // file on an odd mount could still leave it wider; tighten best effort.
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on read-only or foreign-owned mounts.
  }
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// Next can bundle the watchers route and the ambient engine separately; share
// one load/modify/save lock per process across those module instances.
const globals = globalThis as typeof globalThis & { __swarmAmbientRulesLock?: AsyncLock };
const rulesLock = (globals.__swarmAmbientRulesLock ??= new AsyncLock());

/**
 * Run an async read-modify-write against the rules file while holding the
 * in-process rules lock, so concurrent writers that await between load and
 * save cannot lose each other's updates. `fn` receives a fresh load.
 */
export function withLockedRules<T>(fn: (rules: AmbientRule[]) => T | Promise<T>): Promise<T> {
  return rulesLock.acquire(() => fn(loadRules()));
}

export function upsertRule(rule: AmbientRule): void {
  const rules = loadRules().filter((existing) => existing.id !== rule.id);
  rules.push(rule);
  saveRules(rules);
}

export function getRule(userId: string, id: string): AmbientRule | null {
  return loadRules().find((rule) => rule.userId === userId && rule.id === id) ?? null;
}

export function appendDelivery(entry: PostedRunReport): void {
  const file = deliveriesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readDeliveries(): PostedRunReport[] {
  try {
    return fs
      .readFileSync(deliveriesPath(), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PostedRunReport);
  } catch {
    return [];
  }
}
