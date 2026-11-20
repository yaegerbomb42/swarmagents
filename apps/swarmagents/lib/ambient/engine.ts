import { cronBucket, cronMatches } from "./cron";
import { appendDelivery, getRule, loadRules, saveRules } from "./store";
import type { AmbientRule, FireResult, PostedRunReport } from "./types";

export interface AmbientStartInput {
  prompt: string;
  roleId: string;
  fullAuto: true;
  toolAllowlist: readonly string[];
  ambientRuleId: string;
}

export interface AmbientEngineDeps {
  ensureVm: (userId: string) => Promise<void>;
  startRun: (userId: string, input: AmbientStartInput) => { accepted: boolean; runId: string; queued: boolean; error?: string };
  now?: () => Date;
  /** Workspace file mtime in ms, or null when the path is missing. */
  statFile?: (userId: string, filePath: string) => Promise<number | null>;
  /** Latest PR head SHA plus whether any check run failed. */
  githubCi?: (repo: string, pr: number) => Promise<{ sha: string; failed: boolean } | null>;
  readReport?: (runId: string) => { status?: string; summary?: string } | null;
  post?: (entry: PostedRunReport) => Promise<void> | void;
  /** Subscribe to a run's terminal event. Returns unsubscribe. */
  onTerminal?: (runId: string, listener: (status: string) => void) => () => void;
}

const USER_RE = /^[A-Za-z0-9_@.+-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function ambientIdsOk(userId: string, id: string): boolean {
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

export class AmbientEngine {
  constructor(private readonly deps: AmbientEngineDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Wake the user's VM and start Role X in fullAuto under the rule allowlist. */
  async fire(rule: AmbientRule, reason: string): Promise<FireResult> {
    if (!rule.enabled) return { fired: false, error: "rule disabled" };
    if (!rule.toolAllowlist) return { fired: false, error: "allowlist required" };
    try {
      await this.deps.ensureVm(rule.userId);
    } catch (error) {
      return { fired: false, error: error instanceof Error ? error.message : String(error) };
    }
    const prompt = `${rule.prompt}\n\nTrigger: ${reason}`.trim();
    const started = this.deps.startRun(rule.userId, {
      prompt,
      roleId: rule.roleId,
      fullAuto: true,
      toolAllowlist: rule.toolAllowlist,
      ambientRuleId: rule.id,
    });
    if (!started.accepted) return { fired: false, error: started.error ?? "run refused" };
    this.watchReport(rule, started.runId);
    return { fired: true, runId: started.runId, queued: started.queued };
  }

  private watchReport(rule: AmbientRule, runId: string): void {
    const finish = (status: string) => {
      void this.postReport(rule, runId, status);
    };
    if (!this.deps.onTerminal) return;
    const unsubscribe = this.deps.onTerminal(runId, (status) => {
      unsubscribe();
      finish(status);
    });
  }

  async postReport(rule: AmbientRule, runId: string, status: string): Promise<PostedRunReport> {
    const report = this.deps.readReport?.(runId) ?? null;
    const entry: PostedRunReport = {
      ruleId: rule.id,
      userId: rule.userId,
      runId,
      postedAt: Date.now(),
      status: report?.status ?? status,
      summary: report?.summary ?? `Run ${runId} finished (${status}).`,
      reportFound: report !== null,
    };
    if (this.deps.post) await this.deps.post(entry);
    else appendDelivery(entry);
    return entry;
  }

  webhookSecretOk(rule: AmbientRule, presented: string): boolean {
    if (!rule.webhookSecret || !presented) return false;
    return timingSafeEqual(rule.webhookSecret, presented);
  }

  async acceptWebhook(userId: string, id: string, secret: string): Promise<FireResult> {
    if (!ambientIdsOk(userId, id)) return { fired: false, error: "invalid id" };
    const rule = getRule(userId, id);
    if (!rule || rule.kind !== "webhook") return { fired: false, error: "not found" };
    if (!this.webhookSecretOk(rule, secret)) return { fired: false, error: "unauthorized" };
    return this.fire(rule, `webhook /hooks/${userId}/${id}`);
  }

  /** Fire cron rules whose expression matches now and have not fired this minute. */
  async tickCron(rules: AmbientRule[] = loadRules()): Promise<FireResult[]> {
    const now = this.now();
    const results: FireResult[] = [];
    let dirty = false;
    for (const rule of rules) {
      if (!rule.enabled || rule.kind !== "cron" || !rule.cron) continue;
      if (!cronMatches(rule.cron, now, rule.timezone)) continue;
      const bucket = cronBucket(now, rule.timezone);
      if (!bucket || rule.lastCronBucket === bucket) continue;
      const result = await this.fire(rule, `cron ${rule.cron}`);
      results.push(result);
      // Only mark the bucket once the run was actually accepted. A refused or
      // failed fire() must leave the trigger unmarked so the next tick retries.
      if (!result.fired) continue;
      rule.lastCronBucket = bucket;
      dirty = true;
    }
    if (dirty) saveRules(loadRules().map((stored) => rules.find((rule) => rule.id === stored.id) ?? stored));
    return results;
  }

  /** Fire when a watched workspace file's mtime moves forward. */
  async tickFiles(rules: AmbientRule[] = loadRules()): Promise<FireResult[]> {
    if (!this.deps.statFile) return [];
    const results: FireResult[] = [];
    let dirty = false;
    for (const rule of rules) {
      if (!rule.enabled || rule.kind !== "file" || !rule.filePath) continue;
      if (rule.filePath.includes("..") || rule.filePath.startsWith("/")) continue;
      let mtime: number | null;
      try {
        mtime = await this.deps.statFile(rule.userId, rule.filePath);
      } catch {
        continue;
      }
      if (mtime === null) continue;
      const previous = rule.fileMtimeMs;
      if (previous !== undefined && mtime <= previous) continue;
      rule.fileMtimeMs = mtime;
      dirty = true;
      if (previous === undefined) continue;
      results.push(await this.fire(rule, `file ${rule.filePath}`));
    }
    if (dirty) saveRules(loadRules().map((stored) => rules.find((rule) => rule.id === stored.id) ?? stored));
    return results;
  }

  /** Fire when a watched PR has a failed check on a new head SHA. */
  async tickGithub(rules: AmbientRule[] = loadRules()): Promise<FireResult[]> {
    if (!this.deps.githubCi) return [];
    const results: FireResult[] = [];
    let dirty = false;
    for (const rule of rules) {
      if (!rule.enabled || rule.kind !== "github_pr_ci" || !rule.githubRepo || !rule.githubPr) continue;
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rule.githubRepo)) continue;
      let ci: { sha: string; failed: boolean } | null;
      try {
        ci = await this.deps.githubCi(rule.githubRepo, rule.githubPr);
      } catch {
        continue;
      }
      if (!ci?.failed || !ci.sha || ci.sha === rule.githubFiredSha) continue;
      const result = await this.fire(rule, `github ${rule.githubRepo}#${rule.githubPr} sha ${ci.sha} CI failed`);
      results.push(result);
      // Record the head SHA only after the run was accepted, so a red head that
      // failed to wake the VM is retried on the next tick rather than skipped.
      if (!result.fired) continue;
      rule.githubFiredSha = ci.sha;
      dirty = true;
    }
    if (dirty) saveRules(loadRules().map((stored) => rules.find((rule) => rule.id === stored.id) ?? stored));
    return results;
  }
}
