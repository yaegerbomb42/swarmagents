/**
 * F16 — receipt chain entry extractors.
 *
 * Pure functions that turn a run's persisted telemetry events
 * (`SequencedEvent[]` from `readRunEvents`, `lib/telemetry/run-log.ts`)
 * into the `ReceiptChainEntry` values `buildReceiptChain`
 * (`./run-receipt.ts`) hashes. The extractors never invent evidence:
 *
 * - Approvals: only the `"ask"` risk level ever reaches an approval
 *   (`lib/harness/tool-approval.ts`). `"allow"` proceeds with no approval
 *   and `"deny"` is blocked with no approval, so neither appears here.
 *   Each approval is paired by id: `approval.required` /
 *   `approval.requested` (risk level + tool) with `approval.resolved`
 *   (human verdict) and `approval.timeout` (auto-deny). An approval
 *   with no resolution at finalize time is emitted with
 *   `verdict: "pending"` — never a guessed verdict.
 * - Attestations: one entry per `llm.call` provider attempt
 *   (`lib/runtime/llm-gateway.ts`), including failed attempts (failover
 *   retries stay visible). Lens calls ride the same event type
 *   (`lib/lenses/run.ts`) and are excluded, exactly as
 *   `lib/telemetry/usage.ts` excludes them from agent cost.
 * - Command logs: `shell.cmd` / `shell.output` events. These are
 *   published UNREDACTED today (`lib/runtime/manager.ts`), so the
 *   redactor passed in here is load-bearing — no secret that reaches a
 *   command log may reach the receipt.
 *
 * Event shapes differ by emitter: approval events carry their payload
 * as top-level fields (`approval`, `id`, `verdict`), while `llm.call`
 * and `shell.*` carry theirs under `data`. The extractors read both
 * shapes defensively (unknown/malformed payloads are skipped, never
 * crash the receipt build).
 */

import { sha256Hex } from "../library/proof";
import type { SequencedEvent } from "../telemetry/bus";
import type { ReceiptChainEntry } from "./run-receipt";

/** Max characters of (redacted) text kept in one command entry. */
export const MAX_COMMAND_TEXT_CHARS = 4000;
/** Marker appended when a command entry's text was truncated. */
export const COMMAND_TRUNCATION_MARKER = "\n…[TRUNCATED]";

/** The note entry emitted when a run has no per-call attestations. */
export const NO_ATTESTATIONS_NOTE = "no-per-call-attestations" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(event: SequencedEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

function eventData(event: SequencedEvent): Record<string, unknown> {
  const data = asRecord(event).data;
  return isRecord(data) ? data : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// --- prompt -----------------------------------------------------------------

function promptEntry(prompt: string): ReceiptChainEntry {
  return { kind: "prompt", sha256: sha256Hex(prompt) };
}

// --- approvals --------------------------------------------------------------

/** Verdicts an `approval.resolved` event can carry. */
export type ApprovalVerdict = "approved" | "denied" | "expired" | "pending";

interface ApprovalRecord {
  /** seq of the first event that mentioned this approval. */
  seq: number;
  /** ts of the first event that mentioned this approval. */
  ts: number;
  riskLevel: string;
  tool?: string;
  verdict?: ApprovalVerdict;
  resolvedAt?: number;
  timeout?: boolean;
}

function isVerdict(value: unknown): value is Exclude<ApprovalVerdict, "pending"> {
  return value === "approved" || value === "denied" || value === "expired";
}

/**
 * One entry per approval in the run, in first-seen order.
 *
 * Pairs `approval.required` / `approval.requested` (risk level + tool)
 * with `approval.resolved` (verdict) and `approval.timeout` (auto-deny)
 * by approval id. Both `requested` and `required` are emitted for the
 * same approval — they collapse to a single entry. An approval with no
 * resolution at finalize time is emitted with `verdict: "pending"`.
 * A resolution that arrives without a matching required event (e.g. the
 * log was rotated) still yields an entry, with `riskLevel: "ask"` — the
 * only level that ever reaches an approval — and the resolution's own
 * seq/ts.
 */
function extractApprovalEntries(events: readonly SequencedEvent[]): ReceiptChainEntry[] {
  const records = new Map<string, ApprovalRecord>();
  const order: string[] = [];

  function recordFor(id: string, event: SequencedEvent): ApprovalRecord {
    let record = records.get(id);
    if (!record) {
      record = { seq: event.seq, ts: event.ts, riskLevel: "ask" };
      records.set(id, record);
      order.push(id);
    }
    return record;
  }

  for (const event of events) {
    const fields = asRecord(event);
    if (event.type === "approval.required" || event.type === "approval.requested") {
      const approval = isRecord(fields.approval) ? fields.approval : {};
      const id = str(approval.id) ?? `seq:${event.seq}`;
      const record = recordFor(id, event);
      // First required/requested wins for seq/ts; fill in what we know.
      const riskLevel = str(approval.riskLevel);
      if (riskLevel) record.riskLevel = riskLevel;
      const tool = str(approval.tool);
      if (tool) record.tool = tool;
      continue;
    }
    if (event.type === "approval.resolved") {
      const id = str(fields.id) ?? `seq:${event.seq}`;
      const record = recordFor(id, event);
      // First verdict wins: resolving is idempotent in the store.
      if (record.verdict === undefined && isVerdict(fields.verdict)) {
        record.verdict = fields.verdict;
        record.resolvedAt = event.ts;
      }
      continue;
    }
    if (event.type === "approval.timeout") {
      const id = str(fields.id) ?? `seq:${event.seq}`;
      const record = recordFor(id, event);
      record.timeout = true;
      const tool = str(fields.tool);
      if (tool && !record.tool) record.tool = tool;
      continue;
    }
  }

  return order.map((id) => {
    const record = records.get(id)!;
    const entry: Record<string, unknown> = {
      kind: "approval",
      seq: record.seq,
      ts: record.ts,
      riskLevel: record.riskLevel,
      verdict: record.verdict ?? "pending",
    };
    if (record.tool !== undefined) entry.tool = record.tool;
    if (record.resolvedAt !== undefined) entry.resolvedAt = record.resolvedAt;
    if (record.timeout === true) entry.timeout = true;
    return entry as ReceiptChainEntry;
  });
}

// --- attestations -----------------------------------------------------------

/**
 * One entry per non-lens `llm.call` provider attempt, in event order.
 * Failed attempts are kept (failover retries stay visible in the chain);
 * lens calls (`data.source === "lens"`) are excluded. When the run has
 * no agent `llm.call` events at all — e.g. a host-env fallback run, where
 * no provider is configured and the gateway is never called — exactly
 * one note entry is emitted instead; an attestation is never invented.
 */
function extractAttestationEntries(events: readonly SequencedEvent[]): ReceiptChainEntry[] {
  const entries: ReceiptChainEntry[] = [];
  for (const event of events) {
    if (event.type !== "llm.call") continue;
    const data = eventData(event);
    if (data.source === "lens") continue;
    const provider = str(data.provider);
    const model = str(data.model);
    // Without a provider/model the attempt cannot be attested to.
    if (!provider || !model) continue;
    const entry: Record<string, unknown> = {
      kind: "attestation",
      seq: event.seq,
      ts: event.ts,
      provider,
      model,
      attempt: num(data.attempt) ?? 1,
      outcome: str(data.outcome) ?? "unknown",
      latencyMs: num(data.latencyMs) ?? 0,
    };
    const inputTokens = num(data.inputTokens);
    if (inputTokens !== undefined) entry.inputTokens = inputTokens;
    const outputTokens = num(data.outputTokens);
    if (outputTokens !== undefined) entry.outputTokens = outputTokens;
    // `costUsd` is `number | null` on the event; null means "unknown",
    // so only a real number is carried into the chain.
    const costUsd = num(data.costUsd);
    if (costUsd !== undefined) entry.costUsd = costUsd;
    entries.push(entry as ReceiptChainEntry);
  }
  if (entries.length === 0) {
    entries.push({
      kind: "note",
      note: NO_ATTESTATIONS_NOTE,
      reason: "host-env-run",
    });
  }
  return entries;
}

// --- command logs -----------------------------------------------------------

function truncateCommandText(text: string): string {
  if (text.length <= MAX_COMMAND_TEXT_CHARS) return text;
  return text.slice(0, MAX_COMMAND_TEXT_CHARS) + COMMAND_TRUNCATION_MARKER;
}

/**
 * One entry per `shell.cmd` / `shell.output` log line, in event order.
 * Every line is passed through `redact` first (shell logs are published
 * unredacted today, so this step is what keeps secrets out of the
 * receipt), then capped at `MAX_COMMAND_TEXT_CHARS` so a huge output
 * cannot bloat the receipt. Empty lines are skipped.
 */
function extractCommandLogEntries(
  events: readonly SequencedEvent[],
  redact: (text: string) => string,
): ReceiptChainEntry[] {
  const entries: ReceiptChainEntry[] = [];
  for (const event of events) {
    const data = eventData(event);
    let text: string | undefined;
    let stream: "cmd" | "output";
    if (event.type === "shell.cmd") {
      stream = "cmd";
      text = str(data.command);
    } else if (event.type === "shell.output") {
      stream = "output";
      text = str(data.text);
    } else {
      continue;
    }
    if (text === undefined) continue;
    const redacted = truncateCommandText(redact(text));
    if (redacted.length === 0) continue;
    entries.push({ kind: "command", seq: event.seq, ts: event.ts, stream, text: redacted });
  }
  return entries;
}

export {
  extractApprovalEntries,
  extractAttestationEntries,
  extractCommandLogEntries,
  promptEntry,
};
