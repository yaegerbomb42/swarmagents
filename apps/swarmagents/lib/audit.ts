/**
 * Audit log of sensitive actions.
 *
 * Every provider key change, approval decision, snapshot create/restore and
 * login appends one JSON line to `<SWARM_HOME>/audit.jsonl` (falling back to
 * `~/.swarmagents/audit.jsonl` when SWARM_HOME is unset — the same home
 * resolution as the telemetry paths). Each line carries exactly five fields:
 *
 *   { ts, user, action, target, result }
 *
 * `target` is an identifier only — a provider id, approval id, snapshot
 * label or user id. Key material, passwords and tokens are NEVER passed to
 * this module, so they can never land in the log. Writes are best-effort:
 * a failing audit write is logged to stderr and never breaks the action it
 * records.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AuditAction =
  | "provider.add"
  | "provider.delete"
  | "provider.rank"
  | "provider.billing"
  | "provider.effort"
  | "provider.key.add"
  | "provider.key.remove"
  | "provider.key.rotate"
  | "approval.approve"
  | "approval.deny"
  | "approval.expire"
  | "question.answer"
  | "question.expire"
  | "handoff.handback"
  | "handoff.expire"
  | "budget.continue"
  | "budget.stop"
  | "snapshot.create"
  | "snapshot.restore"
  | "snapshot.delete"
  | "login.success"
  | "login.failure"
  | "password.reset.request"
  | "password.reset"
  | "password.change"
  | "email.verify"
  | "email.verify.resend"
  | "signup.botcheck"
  | "session.revoke"
  | "computer.pair"
  | "computer.revoke"
  | "vm.file.upload"
  | "vm.access.denied"
  | "vm.migrate"
  | "desktop.view"
  | "desktop.takeover"
  | "preview.share.create"
  | "preview.share.revoke"
  | "vault.proxy"
  | "run.compare.remember"
  | "gardener.autopilot"
  | "library.unpublish"
  | "git.commit";

export type AuditResult = "success" | "failure";

/**
 * RFC 5321 path-length cap; keeps audit.jsonl targets bounded.
 */
export const MAX_AUDIT_EMAIL_LEN = 254;

/**
 * Normalize a failed-login email for audit `target`: trim, lowercase, strip
 * C0/C1 controls, and hard-cap length so unauthenticated callers cannot flood
 * audit.jsonl with multi-KB payloads.
 */
export function auditLoginFailureTarget(email: unknown): string {
  if (typeof email !== "string" || !email) return "unknown";
  const cleaned = email
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_AUDIT_EMAIL_LEN);
  return cleaned || "unknown";
}

export interface AuditEntry {
  ts: string;
  user: string;
  action: AuditAction;
  target: string;
  result: AuditResult;
}

export const AUDIT_FILE_NAME = "audit.jsonl";

/** Default cap for a single GET /api/audit read; callers may ask for less. */
export const DEFAULT_AUDIT_LIMIT = 200;
export const MAX_AUDIT_LIMIT = 1000;

const MAX_FIELD_LEN = 128;

let override: string | undefined;

/** Point the audit log at a different file (tests). Pass undefined to reset. */
export function configureAuditPath(file: string | undefined): void {
  override = file;
}

// Guarantee strictly-increasing timestamps across writes: several actions can
// otherwise land in the same millisecond, and a timestamp cursor that is shared
// by consecutive entries makes cursor pagination ambiguous (a page boundary can
// fall inside a run of equal timestamps).
let lastRecordedTs = 0;

function nextTs(): string {
  const now = Date.now();
  const ts = now > lastRecordedTs ? now : lastRecordedTs + 1;
  lastRecordedTs = ts;
  return new Date(ts).toISOString();
}

/** Where audit lines are stored. Read per call so a temp SWARM_HOME set by a test takes effect. */
export function getAuditFile(): string {
  if (override !== undefined) return override;
  const home = process.env.SWARM_HOME?.trim();
  if (home) return path.join(home, AUDIT_FILE_NAME);
  return path.join(os.homedir(), ".swarmagents", AUDIT_FILE_NAME);
}

function cleanField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_FIELD_LEN ? trimmed.slice(0, MAX_FIELD_LEN) : trimmed;
}

export interface RecordAuditInput {
  user: string;
  action: AuditAction;
  /** Identifier only (provider id, approval id, snapshot label, user id) — never key material. */
  target: string;
  result: AuditResult;
}

/**
 * Append one audit entry as a JSON line. Never throws: audit persistence
 * must never break the action being recorded.
 */
export function recordAudit(input: RecordAuditInput): void {
  const entry: AuditEntry = {
    ts: nextTs(),
    user: cleanField(input.user) || "unknown",
    action: input.action,
    target: cleanField(input.target),
    result: input.result,
  };
  const line = `${JSON.stringify(entry)}\n`;
  const file = getAuditFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, "utf8");
  } catch (err) {
    console.error(`[audit] could not append to ${file}:`, err);
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.user === "string" &&
    typeof e.action === "string" &&
    typeof e.target === "string" &&
    (e.result === "success" || e.result === "failure")
  );
}

export interface ReadAuditOptions {
  /** Max entries returned, newest first. Defaults to 200, clamped to 1..1000. */
  limit?: number;
  /**
   * Only entries strictly older than this unix-ms timestamp are returned
   * (the pagination cursor). Entries whose `ts` does not parse are never
   * dropped by the cursor — they are treated as unfilterable and kept.
   */
  beforeTs?: number | null;
  /** Exact action, or a prefix ending in `*` / `.`. */
  action?: string;
  /** Restrict to a result. */
  result?: AuditResult;
}

/** Actions match exactly, or by prefix when the filter ends in `*` or `.`. */
export function auditActionMatches(entryAction: string, filter: string): boolean {
  if (filter.endsWith("*")) {
    return entryAction.startsWith(filter.slice(0, -1));
  }
  if (filter.endsWith(".")) {
    return entryAction.startsWith(filter);
  }
  return entryAction === filter;
}

/** Unix ms for an entry's ISO `ts`; NaN when the stored string does not parse. */
export function auditEntryTsMs(entry: AuditEntry): number {
  return Date.parse(entry.ts);
}

/**
 * Audit entries for one caller, newest first, optionally filtered. Malformed
 * lines (e.g. a torn trailing line after a crash) are skipped, never fatal.
 * Entries belonging to other users are never returned.
 *
 * Filtering happens here — across the entire caller's log, not after
 * truncating to a fixed window — so an entry older than any fixed cap remains
 * reachable through cursor pagination. Same-timestamp entries keep their
 * reverse-insertion order (later line first).
 */
export function readAuditEntries(user: string, options: ReadAuditOptions = {}): AuditEntry[] {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_AUDIT_LIMIT) || DEFAULT_AUDIT_LIMIT, 1),
    MAX_AUDIT_LIMIT,
  );
  const beforeTs = options.beforeTs ?? null;
  const actionFilter = options.action;
  const resultFilter = options.result;

  let text: string;
  try {
    text = fs.readFileSync(getAuditFile(), "utf8");
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isAuditEntry(parsed) && parsed.user === user) entries.push(parsed);
    } catch {
      // Skip a torn or hand-edited line; later appends stay valid.
    }
  }

  // Newest first; equal timestamps keep reverse-insertion order.
  entries.reverse();

  const out: AuditEntry[] = [];
  for (const entry of entries) {
    if (beforeTs !== null) {
      const ms = auditEntryTsMs(entry);
      if (!Number.isNaN(ms) && ms >= beforeTs) continue;
    }
    if (actionFilter && !auditActionMatches(entry.action, actionFilter)) continue;
    if (resultFilter && entry.result !== resultFilter) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
