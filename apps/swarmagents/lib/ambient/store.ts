import fs from "node:fs";
import path from "node:path";
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

export function saveRules(rules: AmbientRule[]): void {
  const file = rulesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2));
  fs.renameSync(tmp, file);
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
