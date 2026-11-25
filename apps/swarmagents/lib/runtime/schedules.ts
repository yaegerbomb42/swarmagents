/**
 * schedules.ts — 24/7 autonomous scheduled workflows + signed webhook triggers.
 *
 * A schedule is a recurring autonomous run: every `intervalMinutes` the tick
 * fires the schedule's prompt as a full-auto run (paired with the Always-On
 * VM mode, so the run has somewhere to execute). Each schedule also carries
 * a server-generated webhook secret: POSTing it to
 * /api/runtime/schedules/hooks/<userId>/<id> fires the schedule immediately,
 * without waiting for its next tick.
 *
 * Storage mirrors lib/ambient/store.ts: one atomic JSON file under SWARM_HOME
 * (owner-only dir/file), an in-process lock for read-modify-write, and a
 * `configureSchedulesStore(dir)` override so tests never touch real state.
 * Dispatch is dependency-injected (ensureVm + startRun), so the engine
 * unit-tests with a fake runner and the production deps live in
 * `getScheduleEngineDeps()` (the runtime manager, like ambient/runtime.ts).
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-write";
import { getRuntimeManager } from "./manager";

/** Hard cap: how many schedules one user may own. */
export const MAX_SCHEDULES_PER_USER = 20;
/** Shortest allowed cadence, in minutes. */
export const MIN_INTERVAL_MINUTES = 5;
/** Longest allowed cadence: one week, in minutes. */
export const MAX_INTERVAL_MINUTES = 10_080;
export const MAX_SCHEDULE_NAME_LEN = 120;
export const MAX_SCHEDULE_PROMPT_LEN = 8000;

export interface Schedule {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  /** Recurrence, in minutes (>= MIN_INTERVAL_MINUTES). */
  intervalMinutes: number;
  enabled: boolean;
  /** Server-generated webhook secret. Never returned by the API except once, on create. */
  webhookSecret: string;
  /** Epoch ms of the next due tick. */
  nextRunAt: number;
  /** Epoch ms of the last fired run, when one has fired. */
  lastRunAt?: number;
  /** Run id of the last fired run, when one has fired. */
  lastRunId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A schedule as the API returns it: the secret never leaves the server. */
export type PublicSchedule = Omit<Schedule, "webhookSecret"> & { hasWebhookSecret: boolean };

export function publicSchedule(schedule: Schedule): PublicSchedule {
  const { webhookSecret: _secret, ...rest } = schedule;
  return { ...rest, hasWebhookSecret: schedule.webhookSecret.length > 0 };
}

export const ScheduleCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required.").max(MAX_SCHEDULE_NAME_LEN, "name is too long."),
  prompt: z.string().trim().min(1, "prompt is required.").max(MAX_SCHEDULE_PROMPT_LEN, "prompt is too long."),
  intervalMinutes: z
    .number()
    .int("intervalMinutes must be a whole number of minutes.")
    .min(MIN_INTERVAL_MINUTES, `intervalMinutes must be at least ${MIN_INTERVAL_MINUTES} minutes.`)
    .max(MAX_INTERVAL_MINUTES, `intervalMinutes must be at most ${MAX_INTERVAL_MINUTES} minutes.`),
});

export const SchedulePatchSchema = z
  .object({
    name: z.string().trim().min(1, "name is required.").max(MAX_SCHEDULE_NAME_LEN, "name is too long.").optional(),
    prompt: z.string().trim().min(1, "prompt is required.").max(MAX_SCHEDULE_PROMPT_LEN, "prompt is too long.").optional(),
    intervalMinutes: z
      .number()
      .int("intervalMinutes must be a whole number of minutes.")
      .min(MIN_INTERVAL_MINUTES, `intervalMinutes must be at least ${MIN_INTERVAL_MINUTES} minutes.`)
      .max(MAX_INTERVAL_MINUTES, `intervalMinutes must be at most ${MAX_INTERVAL_MINUTES} minutes.`)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update." });

export type ScheduleCreateInput = z.infer<typeof ScheduleCreateSchema>;
export type SchedulePatchInput = z.infer<typeof SchedulePatchSchema>;

// ---- store ----

function homeDir(): string {
  const home = process.env.SWARM_HOME?.trim();
  if (home) return home;
  return path.join(process.cwd(), ".swarm-ambient");
}

let schedulesOverride: string | undefined;

export function configureSchedulesStore(dir: string): void {
  schedulesOverride = path.join(dir, "schedules.json");
}

function schedulesPath(): string {
  return schedulesOverride ?? path.join(homeDir(), "schedules.json");
}

function isSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object") return false;
  const s = value as Schedule;
  return (
    typeof s.id === "string" &&
    typeof s.userId === "string" &&
    typeof s.name === "string" &&
    typeof s.prompt === "string" &&
    typeof s.intervalMinutes === "number" &&
    typeof s.enabled === "boolean" &&
    typeof s.webhookSecret === "string" &&
    typeof s.nextRunAt === "number" &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number"
  );
}

export function loadSchedules(): Schedule[] {
  try {
    const raw = fs.readFileSync(schedulesPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSchedule);
  } catch {
    return [];
  }
}

/**
 * Schedules carry webhook secrets, so the file is owner-only (0o600) in an
 * owner-only directory, and is replaced atomically (temp + fsync + rename).
 */
export function saveSchedules(schedules: Schedule[]): void {
  const file = schedulesPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(file, JSON.stringify(schedules, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
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

// Next can bundle the route and the tick engine separately; share one
// load/modify/save lock per process across those module instances.
const globals = globalThis as typeof globalThis & { __swarmSchedulesLock?: AsyncLock };
const schedulesLock = (globals.__swarmSchedulesLock ??= new AsyncLock());

/**
 * Run an async read-modify-write against the schedules file while holding
 * the in-process schedules lock, so concurrent writers that await between
 * load and save cannot lose each other's updates. `fn` receives a fresh
 * load and is responsible for saving.
 */
export function withLockedSchedules<T>(fn: (schedules: Schedule[]) => T | Promise<T>): Promise<T> {
  return schedulesLock.acquire(() => fn(loadSchedules()));
}

export function listSchedules(userId: string): Schedule[] {
  return loadSchedules().filter((schedule) => schedule.userId === userId);
}

export function getSchedule(userId: string, id: string): Schedule | null {
  return loadSchedules().find((schedule) => schedule.userId === userId && schedule.id === id) ?? null;
}

export function countSchedules(userId: string): number {
  return listSchedules(userId).length;
}

/**
 * Create a schedule. The id and webhook secret are server-generated; the
 * first tick lands one interval after creation. Throws when the input fails
 * validation or the user already owns MAX_SCHEDULES_PER_USER schedules.
 */
export function createSchedule(userId: string, input: unknown, nowMs: number = Date.now()): Schedule {
  const parsed = ScheduleCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid schedule.");
  }
  const existing = loadSchedules();
  if (existing.filter((schedule) => schedule.userId === userId).length >= MAX_SCHEDULES_PER_USER) {
    throw new Error(`At most ${MAX_SCHEDULES_PER_USER} schedules per user.`);
  }
  const schedule: Schedule = {
    id: `sch_${randomUUID()}`,
    userId,
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    intervalMinutes: parsed.data.intervalMinutes,
    enabled: true,
    webhookSecret: randomBytes(24).toString("hex"),
    nextRunAt: nowMs + parsed.data.intervalMinutes * 60_000,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  existing.push(schedule);
  saveSchedules(existing);
  return schedule;
}

/**
 * Update a schedule. Returns the updated schedule, or null when it does not
 * exist (or belongs to another user). Changing the interval re-bases the
 * next tick on now, so an edited cadence takes effect immediately.
 */
export function updateSchedule(
  userId: string,
  id: string,
  patch: unknown,
  nowMs: number = Date.now(),
): Schedule | null {
  const parsed = SchedulePatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid schedule update.");
  }
  const all = loadSchedules();
  const schedule = all.find((entry) => entry.userId === userId && entry.id === id);
  if (!schedule) return null;
  if (parsed.data.name !== undefined) schedule.name = parsed.data.name;
  if (parsed.data.prompt !== undefined) schedule.prompt = parsed.data.prompt;
  if (parsed.data.intervalMinutes !== undefined) {
    schedule.intervalMinutes = parsed.data.intervalMinutes;
    schedule.nextRunAt = nowMs + parsed.data.intervalMinutes * 60_000;
  }
  if (parsed.data.enabled !== undefined) schedule.enabled = parsed.data.enabled;
  schedule.updatedAt = nowMs;
  saveSchedules(all);
  return schedule;
}

export function deleteSchedule(userId: string, id: string): boolean {
  const all = loadSchedules();
  const kept = all.filter((schedule) => !(schedule.userId === userId && schedule.id === id));
  if (kept.length === all.length) return false;
  saveSchedules(kept);
  return true;
}

// ---- cadence ----

/**
 * The next tick after `lastRunMs` on a fixed `intervalMinutes` cadence,
 * caught up past `nowMs` with arithmetic (no loop: a week of downtime at a
 * 5-minute cadence is 2,016 skipped ticks). The first tick after creation
 * is `createdAt + interval`; a run that fired at `lastRunMs` is followed by
 * `lastRunMs + interval`, pushed forward past now when the process was down.
 */
export function computeNextRunAt(lastRunMs: number, intervalMinutes: number, nowMs: number): number {
  const step = intervalMinutes * 60_000;
  if (nowMs <= lastRunMs) return lastRunMs + step;
  const skips = Math.floor((nowMs - lastRunMs) / step) + 1;
  return lastRunMs + skips * step;
}

export function isScheduleDue(schedule: Schedule, nowMs: number): boolean {
  return schedule.enabled && schedule.nextRunAt <= nowMs;
}

// ---- engine ----

export interface ScheduleEngineDeps {
  ensureVm: (userId: string) => Promise<void>;
  startRun: (
    userId: string,
    input: { prompt: string; fullAuto: boolean },
  ) => { accepted: boolean; runId: string; queued: boolean; error?: string };
  now?: () => number;
}

export interface ScheduleFireResult {
  fired: boolean;
  runId?: string;
  queued?: boolean;
  error?: string;
}

const USER_RE = /^[A-Za-z0-9_@.+-]{1,128}$/;
const ID_RE = /^sch_[A-Za-z0-9-]{36}$/;

export function scheduleIdsOk(userId: string, id: string): boolean {
  return USER_RE.test(userId) && ID_RE.test(id);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Wake the user's VM and start the schedule's prompt as a full-auto run. */
export async function fireSchedule(
  schedule: Schedule,
  deps: ScheduleEngineDeps,
): Promise<ScheduleFireResult> {
  if (!schedule.enabled) return { fired: false, error: "schedule paused" };
  try {
    await deps.ensureVm(schedule.userId);
  } catch (error) {
    return { fired: false, error: error instanceof Error ? error.message : String(error) };
  }
  const started = deps.startRun(schedule.userId, {
    prompt: `${schedule.prompt}\n\nTrigger: schedule ${schedule.name} (${schedule.id})`.trim(),
    fullAuto: true,
  });
  if (!started.accepted) return { fired: false, error: started.error ?? "run refused" };
  return { fired: true, runId: started.runId, queued: started.queued };
}

/**
 * Record a fired run on the stored schedule. `advanceNext` moves the next
 * tick one interval past the fire (interval cadence); a webhook fire leaves
 * the cadence alone. Reloads under the store lock so a concurrent writer's
 * update is not lost.
 */
async function recordScheduleRun(
  userId: string,
  id: string,
  runId: string,
  nowMs: number,
  advanceNext: boolean,
): Promise<void> {
  await withLockedSchedules((all) => {
    const current = all.find((entry) => entry.userId === userId && entry.id === id);
    if (!current) return;
    current.lastRunAt = nowMs;
    current.lastRunId = runId;
    if (advanceNext) {
      current.nextRunAt = computeNextRunAt(nowMs, current.intervalMinutes, nowMs);
    }
    current.updatedAt = nowMs;
    saveSchedules(all);
  });
}

export interface ScheduleTickResult extends ScheduleFireResult {
  scheduleId: string;
}

/** In-flight tick promise: overlapping ticks share one run, never double-fire. */
let tickInFlight: Promise<ScheduleTickResult[]> | null = null;

/**
 * Fire every enabled schedule whose next tick is due. A fire that the
 * runner refuses leaves nextRunAt untouched, so the next tick retries it
 * instead of silently skipping a run. A tick already in flight is shared
 * rather than run twice (safe lock against overlapping ticks).
 */
export function tickDueSchedules(
  deps: ScheduleEngineDeps,
  nowMs?: number,
  schedules: Schedule[] = loadSchedules(),
): Promise<ScheduleTickResult[]> {
  if (tickInFlight) return tickInFlight;
  const run = (async (): Promise<ScheduleTickResult[]> => {
    const now = nowMs ?? deps.now?.() ?? Date.now();
    const results: ScheduleTickResult[] = [];
    for (const schedule of schedules) {
      if (!isScheduleDue(schedule, now)) continue;
      const result = await fireSchedule(schedule, deps);
      results.push({ scheduleId: schedule.id, ...result });
      if (!result.fired || !result.runId) continue;
      await recordScheduleRun(schedule.userId, schedule.id, result.runId, now, true);
    }
    return results;
  })();
  tickInFlight = run;
  return run.finally(() => {
    if (tickInFlight === run) tickInFlight = null;
  });
}

/** Secret check without firing. Exists so the webhook route can reject an
 *  unauthenticated caller before reading (and spending) the request body. */
export function checkScheduleWebhook(
  userId: string,
  id: string,
  secret: string,
): "ok" | "invalid id" | "not found" | "unauthorized" {
  if (!scheduleIdsOk(userId, id)) return "invalid id";
  const schedule = getSchedule(userId, id);
  if (!schedule) return "not found";
  if (!schedule.webhookSecret || !secret) return "unauthorized";
  if (!timingSafeEqual(schedule.webhookSecret, secret)) return "unauthorized";
  return "ok";
}

export async function triggerScheduleByWebhook(
  userId: string,
  id: string,
  secret: string,
  deps: ScheduleEngineDeps,
): Promise<ScheduleFireResult> {
  const check = checkScheduleWebhook(userId, id, secret);
  if (check !== "ok") return { fired: false, error: check };
  const schedule = getSchedule(userId, id);
  if (!schedule) return { fired: false, error: "not found" };
  const result = await fireSchedule(schedule, deps);
  if (result.fired && result.runId) {
    await recordScheduleRun(userId, id, result.runId, deps.now?.() ?? Date.now(), false);
  }
  return result;
}

// ---- production wiring ----

let engineDepsOverride: ScheduleEngineDeps | null = null;

function productionDeps(): ScheduleEngineDeps {
  const runtime = getRuntimeManager();
  return {
    ensureVm: async (userId) => {
      await runtime.vmManager.ensure(userId);
    },
    startRun: (userId, input) => runtime.start(userId, input),
  };
}

export function getScheduleEngineDeps(): ScheduleEngineDeps {
  return engineDepsOverride ?? productionDeps();
}

export function setScheduleEngineDepsForTesting(deps: ScheduleEngineDeps | null): void {
  engineDepsOverride = deps;
}

let tickTimer: NodeJS.Timeout | null = null;

/**
 * Poll due schedules in the background (module-level interval, unref'd so
 * it never keeps the process alive by itself). Idempotent; the tick itself
 * never throws into the interval — a failed tick logs and the next one
 * retries whatever is still due. Started from instrumentation.ts, next to
 * the ambient watchers.
 */
export function startScheduleTicks(intervalMs: number = 60_000): void {
  if (tickTimer) return;
  const tick = () => {
    void tickDueSchedules(getScheduleEngineDeps()).catch((error) =>
      console.error("[schedules] tick", error),
    );
  };
  tickTimer = setInterval(tick, intervalMs);
  tickTimer.unref?.();
}

export function stopScheduleTicksForTesting(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}
