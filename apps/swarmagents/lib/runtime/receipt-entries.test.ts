/**
 * F16 — receipt chain entry extractors: approval pairing, per-attempt
 * attestations, redacted + capped command logs, prompt hashing, and an
 * end-to-end chain/sign/verify pass with a tamper that names its link.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../library/proof";
import { makeRedactor } from "../harness/redact";
import type { SequencedEvent } from "../telemetry/bus";
import { RECEIPT_FORMAT, buildReceiptChain, signReceipt, verifyReceipt } from "./run-receipt";
import {
  COMMAND_TRUNCATION_MARKER,
  MAX_COMMAND_TEXT_CHARS,
  extractApprovalEntries,
  extractAttestationEntries,
  extractCommandLogEntries,
  promptEntry,
} from "./receipt-entries";

function ev(overrides: Record<string, unknown>): SequencedEvent {
  return { runId: "run_receipt_entries_1", seq: 1, ts: 1_000, ...overrides } as unknown as SequencedEvent;
}

function approvalRequired(seq: number, ts: number, approval: Record<string, unknown>) {
  return ev({ type: "approval.required", seq, ts, approval });
}

function approvalRequested(seq: number, ts: number, approval: Record<string, unknown>) {
  return ev({ type: "approval.requested", seq, ts, approval });
}

function approvalResolved(seq: number, ts: number, id: string, verdict: string) {
  return ev({ type: "approval.resolved", seq, ts, id, verdict });
}

function llmCall(
  seq: number,
  ts: number,
  data: Record<string, unknown>,
): SequencedEvent {
  return ev({ type: "llm.call", seq, ts, data });
}

const TEST_SECRET = "test-receipt-secret";

/** A secret-shaped token: `sk-` + 24 chars matches SECRET_PATTERNS. */
const PLANTED_TOKEN = `sk-${"A".repeat(24)}`;

// --- approvals --------------------------------------------------------------

test("approval pairing: required + resolved yields one entry with both", () => {
  const events = [
    approvalRequired(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalResolved(5, 5_000, "a1", "approved"),
  ];
  const entries = extractApprovalEntries(events);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    kind: "approval",
    seq: 2,
    ts: 2_000,
    riskLevel: "ask",
    verdict: "approved",
    tool: "Bash",
    resolvedAt: 5_000,
  });
});

test("approval pairing: requested + required for one approval collapse to one entry", () => {
  const events = [
    approvalRequested(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalRequired(3, 2_001, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalResolved(5, 5_000, "a1", "denied"),
  ];
  const entries = extractApprovalEntries(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.seq, 2);
  assert.equal((entries[0] as Record<string, unknown>).verdict, "denied");
});

test("approval pairing: timeout before an expired resolution is an auto-deny entry", () => {
  const events = [
    approvalRequired(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    ev({ type: "approval.timeout", seq: 4, ts: 4_000, id: "a1", tool: "Bash" }),
    approvalResolved(5, 5_000, "a1", "expired"),
  ];
  const entries = extractApprovalEntries(events);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    kind: "approval",
    seq: 2,
    ts: 2_000,
    riskLevel: "ask",
    verdict: "expired",
    tool: "Bash",
    resolvedAt: 5_000,
    timeout: true,
  });
});

test("approval pairing: an unresolved approval is pending, never a guessed verdict", () => {
  const events = [
    approvalRequired(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
  ];
  const entries = extractApprovalEntries(events);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    kind: "approval",
    seq: 2,
    ts: 2_000,
    riskLevel: "ask",
    verdict: "pending",
    tool: "Bash",
  });
});

test("approval pairing: multiple approvals stay separate and in first-seen order", () => {
  const events = [
    approvalRequired(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalRequired(3, 3_000, { id: "a2", tool: "Read", riskLevel: "ask" }),
    approvalResolved(4, 4_000, "a2", "approved"),
  ];
  const entries = extractApprovalEntries(events);
  assert.equal(entries.length, 2);
  assert.equal((entries[0] as Record<string, unknown>).verdict, "pending");
  assert.equal((entries[1] as Record<string, unknown>).verdict, "approved");
  assert.equal((entries[1] as Record<string, unknown>).tool, "Read");
});

// --- attestations -----------------------------------------------------------

test("attestations: failover retries emit one entry per attempt", () => {
  const events = [
    llmCall(2, 2_000, {
      provider: "nvidia",
      model: "nemotron-3.5-lightning-30b-a3b",
      attempt: 1,
      outcome: "429",
      latencyMs: 120,
      costUsd: null,
    }),
    llmCall(3, 3_000, {
      provider: "nvidia",
      model: "nemotron-3.5-lightning-30b-a3b",
      attempt: 2,
      outcome: "ok",
      latencyMs: 850,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    }),
  ];
  const entries = extractAttestationEntries(events);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    kind: "attestation",
    seq: 2,
    ts: 2_000,
    provider: "nvidia",
    model: "nemotron-3.5-lightning-30b-a3b",
    attempt: 1,
    outcome: "429",
    latencyMs: 120,
  });
  assert.deepEqual(entries[1], {
    kind: "attestation",
    seq: 3,
    ts: 3_000,
    provider: "nvidia",
    model: "nemotron-3.5-lightning-30b-a3b",
    attempt: 2,
    outcome: "ok",
    latencyMs: 850,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
  });
});

test("attestations: lens calls are excluded; a lens-only run gets the host-env note", () => {
  const events = [
    llmCall(2, 2_000, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      attempt: 1,
      outcome: "ok",
      latencyMs: 400,
      source: "lens",
      lens: "summary",
      costUsd: 0.002,
    }),
  ];
  const entries = extractAttestationEntries(events);
  assert.deepEqual(entries, [
    { kind: "note", note: "no-per-call-attestations", reason: "host-env-run" },
  ]);
});

test("attestations: zero llm.call events emit exactly one host-env note", () => {
  const entries = extractAttestationEntries([
    ev({ type: "run.started", seq: 1, ts: 1_000 }),
    ev({ type: "run.finished", seq: 9, ts: 9_000 }),
  ]);
  assert.deepEqual(entries, [
    { kind: "note", note: "no-per-call-attestations", reason: "host-env-run" },
  ]);
});

// --- command logs -----------------------------------------------------------

test("command logs: a planted sk- token never appears; [REDACTED] does", () => {
  const redact = makeRedactor();
  const events = [
    ev({ type: "shell.cmd", seq: 2, ts: 2_000, data: { command: "echo hello", argv: ["echo", "hello"] } }),
    ev({
      type: "shell.output",
      seq: 3,
      ts: 3_000,
      data: { stream: "stdout", text: `key is ${PLANTED_TOKEN} do not leak` },
    }),
    ev({
      type: "shell.output",
      seq: 4,
      ts: 4_000,
      data: { stream: "stderr", text: "clean line" },
    }),
  ];
  const entries = extractCommandLogEntries(events, redact);
  assert.equal(entries.length, 3);
  const texts = entries.map((entry) => (entry as Record<string, unknown>).text as string);
  for (const text of texts) assert.ok(!text.includes(PLANTED_TOKEN), "planted token leaked");
  assert.ok(
    texts.some((text) => text.includes("[REDACTED]")),
    "expected a [REDACTED] marker in the redacted output",
  );
  assert.equal((entries[0] as Record<string, unknown>).stream, "cmd");
  assert.equal((entries[1] as Record<string, unknown>).stream, "output");
});

test("command logs: env-carried secrets are redacted by literal value", () => {
  const envSecret = "hunter2-my-env-secret";
  const redact = makeRedactor({ MY_API_KEY: envSecret });
  const events = [
    ev({
      type: "shell.output",
      seq: 2,
      ts: 2_000,
      data: { stream: "stdout", text: `token=${envSecret} end` },
    }),
  ];
  const entries = extractCommandLogEntries(events, redact);
  assert.equal(entries.length, 1);
  const text = (entries[0] as Record<string, unknown>).text as string;
  assert.ok(!text.includes(envSecret), "env secret leaked");
  assert.ok(text.includes("[REDACTED]"));
});

test("command logs: long output is truncated at the cap with a marker", () => {
  const redact = makeRedactor();
  const longText = "x".repeat(MAX_COMMAND_TEXT_CHARS + 500);
  const events = [
    ev({ type: "shell.output", seq: 2, ts: 2_000, data: { stream: "stdout", text: longText } }),
  ];
  const entries = extractCommandLogEntries(events, redact);
  assert.equal(entries.length, 1);
  const text = (entries[0] as Record<string, unknown>).text as string;
  assert.equal(text.length, MAX_COMMAND_TEXT_CHARS + COMMAND_TRUNCATION_MARKER.length);
  assert.ok(text.endsWith(COMMAND_TRUNCATION_MARKER));
});

test("command logs: empty lines are skipped", () => {
  const redact = makeRedactor();
  const events = [
    ev({ type: "shell.output", seq: 2, ts: 2_000, data: { stream: "stdout", text: "" } }),
    ev({ type: "shell.cmd", seq: 3, ts: 3_000, data: { command: "ls", argv: ["ls"] } }),
  ];
  const entries = extractCommandLogEntries(events, redact);
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as Record<string, unknown>).stream, "cmd");
});

// --- prompt -----------------------------------------------------------------

test("prompt entry hashes the run prompt", () => {
  const prompt = "Deploy the thing";
  assert.deepEqual(promptEntry(prompt), { kind: "prompt", sha256: sha256Hex(prompt) });
});

// --- end to end -------------------------------------------------------------

/** A realistic fixture log: prompt, one approval, a failover pair, shell lines. */
function fixtureEvents(): SequencedEvent[] {
  return [
    ev({ type: "run.started", seq: 1, ts: 1_000, provider: "nvidia" }),
    approvalRequested(2, 2_000, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalRequired(3, 2_001, { id: "a1", tool: "Bash", riskLevel: "ask" }),
    approvalResolved(4, 4_000, "a1", "approved"),
    llmCall(5, 5_000, {
      provider: "nvidia",
      model: "nemotron-3.5-lightning-30b-a3b",
      attempt: 1,
      outcome: "429",
      latencyMs: 120,
      costUsd: null,
    }),
    llmCall(6, 6_000, {
      provider: "nvidia",
      model: "nemotron-3.5-lightning-30b-a3b",
      attempt: 2,
      outcome: "ok",
      latencyMs: 850,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    }),
    ev({ type: "shell.cmd", seq: 7, ts: 7_000, data: { command: "npm test", argv: ["npm", "test"] } }),
    ev({
      type: "shell.output",
      seq: 8,
      ts: 8_000,
      data: { stream: "stdout", text: `leaked ${PLANTED_TOKEN} here` },
    }),
  ];
}

test("end to end: entries chain, sign, and verify; tampering names the link", () => {
  const redact = makeRedactor();
  const events = fixtureEvents();
  const entries = [
    promptEntry("Deploy the thing"),
    ...extractApprovalEntries(events),
    ...extractAttestationEntries(events),
    ...extractCommandLogEntries(events, redact),
  ];
  // prompt + 1 approval + 2 attestations + 2 command lines.
  assert.equal(entries.length, 6);

  const { links, head } = buildReceiptChain(entries);
  const receipt = signReceipt(
    { format: RECEIPT_FORMAT, runId: "run_receipt_entries_1", createdAt: 9_000, head, links },
    TEST_SECRET,
  );
  assert.deepEqual(verifyReceipt(receipt, TEST_SECRET), { ok: true });

  // The planted token must not survive into the signed receipt either.
  assert.ok(!JSON.stringify(receipt).includes(PLANTED_TOKEN), "planted token in receipt");

  // Tamper the second attestation's outcome (link index 3, "ok" -> "429")
  // and verify names exactly that link.
  const tampered = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  const tamperedEntry = tampered.links[3]?.entry as Record<string, unknown>;
  tamperedEntry.outcome = "429";
  const verdict = verifyReceipt(tampered, TEST_SECRET);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failedLink, 3);
  assert.equal(verdict.reason, "chain");
});
