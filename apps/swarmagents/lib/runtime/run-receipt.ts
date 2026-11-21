/**
 * F16 — Signed audit receipts for run reports.
 *
 * A run report (`report.json`) gains a tamper-evident hash chain plus an
 * HMAC signature — the "receipt" — so anyone holding the report can check
 * that the prompt, approval decisions, provider/model attestations, redacted
 * command logs and artifact hashes it records are exactly what the server
 * saw at finalize time. Tampering with any link breaks that link and every
 * link after it, and verification reports exactly which link failed.
 *
 * Signing reuses F4's scheme (`lib/library/proof.ts`): HMAC-SHA256 keyed by
 * `SWARM_SESSION_SECRET`, domain-separated, with its own format marker.
 * The receipt has its own domain (`swarmagents:receipt:v1`) and its own
 * shape — it is NOT a `ProofBundle`. The helpers `canonicalJson`,
 * `sha256Hex` and `proofSecret` are imported from proof.ts rather than
 * re-implemented, so the two schemes can never drift apart.
 *
 * Trust model, stated plainly (same as F4): the signature proves *this
 * server* produced the receipt from a run it executed — it is not the
 * publisher's signature, and a receipt signed on one instance will not
 * verify on another instance with a different secret. If
 * `SWARM_SESSION_SECRET` is unset, signing refuses outright (an empty key
 * would be worse than no receipt).
 *
 * Chain construction: each link covers the canonical JSON of its entry
 * plus the previous link's hash —
 * `hash = sha256Hex(prev + canonicalJson(entry))`. The genesis link's
 * `prev` is 64 zero characters (`GENESIS_PREV`); there is no "previous
 * hash" before the first entry, so a fixed, documented constant stands
 * in. An empty chain (no entries) has zero links and its head is
 * `GENESIS_PREV`. The head is the hash of the last link and is covered
 * by the signature, so tampering with the head breaks verification too.
 *
 * The receipt is built at finalize time (see `lib/runtime/run-reporter.ts`)
 * and stored IN `report.json` — unlike `verification`/`audit`, which are
 * merged at serve time and are not stored.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, proofSecret, sha256Hex } from "../library/proof";

/** Receipt format marker; bump if the signed payload shape ever changes. */
export const RECEIPT_FORMAT = "swarmagents.receipt/v1";
/** Domain separator for the HMAC input (see module doc). */
export const RECEIPT_DOMAIN = "swarmagents:receipt:v1";
/**
 * `prev` of the genesis (first) link: 64 zero characters. A fixed constant
 * is used because there is no previous link hash before the first entry;
 * any verifier re-deriving the chain starts from this same value.
 */
export const GENESIS_PREV = "0".repeat(64);

/** Kinds of evidence a receipt chain link can carry. */
export type ReceiptChainEntryKind =
  | "prompt"
  | "approval"
  | "attestation"
  | "command"
  | "artifact"
  | "note";

/**
 * One entry in the chain. Kept permissive on purpose: the entry
 * extractors (prompt hash, approval decisions, attestations, redacted
 * command logs, artifact hashes) supply the fields; every field must be
 * JSON-serializable so `canonicalJson` is deterministic. `kind`
 * discriminates the entry; the free-form fields carry the evidence.
 */
export type ReceiptChainEntry =
  | { kind: "prompt"; [key: string]: unknown }
  | { kind: "approval"; [key: string]: unknown }
  | { kind: "attestation"; [key: string]: unknown }
  | { kind: "command"; [key: string]: unknown }
  | { kind: "artifact"; [key: string]: unknown }
  | { kind: "note"; [key: string]: unknown };

/** One link in the hash chain. */
export interface ReceiptChainLink {
  /** Position in the chain (0-based); links must be sequential. */
  seq: number;
  /** Mirrors `entry.kind` so the chain is readable without parsing entries. */
  kind: ReceiptChainEntryKind;
  /** `sha256Hex(prev + canonicalJson(entry))`. */
  hash: string;
  /** Previous link's hash, or `GENESIS_PREV` for the first link. */
  prev: string;
  /** The canonical entry object this link commits to. */
  entry: ReceiptChainEntry;
}

/** The signed receipt stored in `report.json`. */
export interface RunReceipt {
  /** Must equal `RECEIPT_FORMAT`. */
  format: string;
  runId: string;
  /** Epoch ms the receipt was built (finalize time). */
  createdAt: number;
  /** Hash of the last chain link (`GENESIS_PREV` when the chain is empty). */
  head: string;
  links: ReceiptChainLink[];
  /**
   * Hex HMAC-SHA256 over the canonical receipt (minus this field).
   * `null` when signing was unavailable at build time (server secret
   * unset) — the receipt is stored unsigned rather than failing the run,
   * and `signingError` records why. A null signature never verifies.
   */
  signature: string | null;
  /** Why the receipt is unsigned, when `signature` is null. */
  signingError?: string;
}

/** Outcome of a receipt/chain verification. Never throws. */
export interface ReceiptVerification {
  ok: boolean;
  /** Index of the first chain link that failed re-derivation, when known. */
  failedLink?: number;
  /**
   * Why verification failed: `"format"` (wrong/malformed receipt shape),
   * `"chain"` (a link hash does not re-derive), or `"signature"` (the
   * HMAC does not check out — includes a tampered head, which the
   * signature covers — or the secret is unset/wrong).
   */
  reason?: "format" | "chain" | "signature";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Build the hash chain over the entries, in order. Pure and deterministic:
 * the same entries always produce the same links and head. An empty entry
 * list yields zero links and a head of `GENESIS_PREV`.
 */
export function buildReceiptChain(entries: ReceiptChainEntry[]): {
  links: ReceiptChainLink[];
  head: string;
} {
  const links: ReceiptChainLink[] = [];
  let prev = GENESIS_PREV;
  for (let seq = 0; seq < entries.length; seq += 1) {
    const entry = entries[seq]!;
    const hash = sha256Hex(prev + canonicalJson(entry));
    links.push({ seq, kind: entry.kind, hash, prev, entry });
    prev = hash;
  }
  return { links, head: prev };
}

/** The exact bytes the HMAC covers: domain + canonical receipt, no signature. */
export function receiptSigningInput(receipt: Omit<RunReceipt, "signature">): string {
  return `${RECEIPT_DOMAIN}:${canonicalJson(receipt)}`;
}

/**
 * Sign an unsigned receipt. Throws when the server secret is unset — a
 * receipt signed with an empty key would be worse than no receipt at all.
 * An explicit `secret` overrides `SWARM_SESSION_SECRET` (used by tests);
 * callers in production omit it.
 */
export function signReceipt(
  receipt: Omit<RunReceipt, "signature">,
  secret?: string,
): RunReceipt {
  const key = secret ?? proofSecret();
  if (!key) {
    throw new Error(
      "Receipt signing is not configured on this server (SWARM_SESSION_SECRET is unset).",
    );
  }
  const signature = createHmac("sha256", key).update(receiptSigningInput(receipt)).digest("hex");
  return { ...receipt, signature };
}

/**
 * Pure chain check, no signature involved: re-derive every link hash in
 * order from `GENESIS_PREV` and confirm each link's `seq`, `kind` and
 * `prev` line up. Returns the index of the first failing link, or `ok`
 * when the whole chain re-derives. Never throws.
 */
export function verifyReceiptChain(links: unknown): ReceiptVerification {
  if (!Array.isArray(links)) return { ok: false, reason: "format" };
  let prev = GENESIS_PREV;
  for (let seq = 0; seq < links.length; seq += 1) {
    const link = links[seq] as unknown;
    if (!isRecord(link)) return { ok: false, failedLink: seq, reason: "chain" };
    if (link.seq !== seq) return { ok: false, failedLink: seq, reason: "chain" };
    if (!isRecord(link.entry) || typeof link.entry.kind !== "string") {
      return { ok: false, failedLink: seq, reason: "chain" };
    }
    if (link.kind !== link.entry.kind) return { ok: false, failedLink: seq, reason: "chain" };
    if (link.prev !== prev) return { ok: false, failedLink: seq, reason: "chain" };
    if (!isHex64(link.hash)) return { ok: false, failedLink: seq, reason: "chain" };
    const expected = sha256Hex(prev + canonicalJson(link.entry));
    if (link.hash !== expected) return { ok: false, failedLink: seq, reason: "chain" };
    prev = link.hash;
  }
  return { ok: true };
}

/**
 * Verify a stored receipt: format first, then the whole chain (naming the
 * first failing link), then the HMAC with a timing-safe comparison. Any
 * failure — wrong format, tampered link, tampered head (covered by the
 * signature), missing/malformed signature, unset or wrong secret — is
 * simply "not verified"; the caller never shows it as verified. Never
 * throws. An explicit `secret` overrides `SWARM_SESSION_SECRET` (tests).
 */
export function verifyReceipt(receipt: unknown, secret?: string): ReceiptVerification {
  if (!isRecord(receipt)) return { ok: false, reason: "format" };
  if (receipt.format !== RECEIPT_FORMAT) return { ok: false, reason: "format" };
  if (typeof receipt.runId !== "string" || !receipt.runId) {
    return { ok: false, reason: "format" };
  }
  if (typeof receipt.createdAt !== "number" || !Number.isFinite(receipt.createdAt)) {
    return { ok: false, reason: "format" };
  }
  if (!isHex64(receipt.head)) return { ok: false, reason: "format" };
  if (!Array.isArray(receipt.links)) return { ok: false, reason: "format" };
  const chain = verifyReceiptChain(receipt.links);
  if (!chain.ok) return chain;
  // The head is covered by the signature (it is part of the signed
  // payload), so a tampered head fails the HMAC check below as
  // "signature" — it is not a link failure.
  const { signature, ...unsigned } = receipt as unknown as RunReceipt;
  if (!isHex64(signature)) return { ok: false, reason: "signature" };
  const key = secret ?? proofSecret();
  if (!key) return { ok: false, reason: "signature" };
  const expectedMac = createHmac("sha256", key)
    .update(receiptSigningInput(unsigned as Omit<RunReceipt, "signature">))
    .digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expectedMac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true };
}
