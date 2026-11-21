/**
 * F16 — signed audit receipts: chain construction, sign/verify, tamper
 * resistance (naming the exact failing link), and secret handling.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_PREV,
  RECEIPT_DOMAIN,
  RECEIPT_FORMAT,
  buildReceiptChain,
  receiptSigningInput,
  signReceipt,
  verifyReceipt,
  verifyReceiptChain,
  type ReceiptChainEntry,
  type RunReceipt,
} from "./run-receipt";

let savedEnv: NodeJS.ProcessEnv;

test.beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.SWARM_SESSION_SECRET = "test-receipt-secret-do-not-use";
});

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/** A realistic entry set: prompt, approval, attestation, command, artifact. */
function sampleEntries(): ReceiptChainEntry[] {
  return [
    { kind: "prompt", hash: "a".repeat(64) },
    { kind: "approval", decision: "allow", tool: "Bash", ts: 1_700_000_000_000 },
    { kind: "attestation", provider: "test-provider", model: "test-model", ts: 1_700_000_000_001 },
    { kind: "command", command: "npm test", exitCode: 0, ts: 1_700_000_000_002 },
    { kind: "artifact", rel: "out.txt", hash: "b".repeat(64), size: 12 },
  ];
}

function signedReceipt(entries: ReceiptChainEntry[] = sampleEntries()): RunReceipt {
  const { links, head } = buildReceiptChain(entries);
  return signReceipt({
    format: RECEIPT_FORMAT,
    runId: "run_receipt_1",
    createdAt: 1_700_000_000_000,
    head,
    links,
  });
}

test("a signed receipt verifies, and the chain is deterministic", () => {
  const receipt = signedReceipt();
  assert.equal(receipt.format, RECEIPT_FORMAT);
  assert.equal(receipt.links.length, 5);
  assert.equal(receipt.links[0]?.prev, GENESIS_PREV);
  assert.equal(receipt.head, receipt.links[receipt.links.length - 1]?.hash);
  assert.deepEqual(verifyReceipt(receipt), { ok: true });
  assert.deepEqual(verifyReceiptChain(receipt.links), { ok: true });
  // Genesis determinism: the same entries always produce the same head.
  const again = signedReceipt();
  assert.equal(again.head, receipt.head);
  assert.deepEqual(
    again.links.map((link) => link.hash),
    receipt.links.map((link) => link.hash),
  );
  // The signing input is domain-separated from F4's proof domain.
  const { signature: _sig, ...unsigned } = receipt;
  assert.ok(receiptSigningInput(unsigned).startsWith(`${RECEIPT_DOMAIN}:`));
});

test("tampering any link's entry fails verification and names that link", () => {
  const entries = sampleEntries();
  for (let i = 0; i < entries.length; i += 1) {
    const receipt = signedReceipt(entries);
    const tampered = structuredClone(receipt);
    const link = tampered.links[i]!;
    // Change a field inside the entry (kind-specific, so it is a real tamper).
    if (link.kind === "approval") link.entry.decision = "deny";
    else if (link.kind === "prompt") link.entry.hash = "c".repeat(64);
    else if (link.kind === "attestation") link.entry.model = "other-model";
    else if (link.kind === "command") link.entry.exitCode = 1;
    else link.entry.size = 13;
    const result = verifyReceipt(tampered);
    assert.equal(result.ok, false, `link ${i} tamper must fail`);
    assert.equal(result.failedLink, i, `link ${i} tamper must name index ${i}`);
    assert.equal(result.reason, "chain");
    // The pure chain check agrees, without needing the signature.
    assert.deepEqual(verifyReceiptChain(tampered.links), {
      ok: false,
      failedLink: i,
      reason: "chain",
    });
  }
});

test("tampering an artifact entry's hash fails and names its link", () => {
  const receipt = signedReceipt();
  const tampered = structuredClone(receipt);
  const artifactLink = tampered.links[4]!;
  assert.equal(artifactLink.kind, "artifact");
  artifactLink.entry.hash = "d".repeat(64);
  assert.deepEqual(verifyReceipt(tampered), { ok: false, failedLink: 4, reason: "chain" });
});

test("tampering the head fails verification", () => {
  const receipt = signedReceipt();
  // Head is covered by the signature, so a tampered head is a signature failure.
  const tampered = { ...receipt, head: "e".repeat(64) };
  assert.deepEqual(verifyReceipt(tampered), { ok: false, reason: "signature" });
  // A malformed head is a format failure.
  assert.deepEqual(
    verifyReceipt({ ...receipt, head: "not-a-hash" }),
    { ok: false, reason: "format" },
  );
});

test("signing refuses an unset secret and verification fails without it", () => {
  delete process.env.SWARM_SESSION_SECRET;
  const { links, head } = buildReceiptChain(sampleEntries());
  assert.throws(
    () =>
      signReceipt({ format: RECEIPT_FORMAT, runId: "run_receipt_1", createdAt: 0, head, links }),
    /SWARM_SESSION_SECRET/,
  );
  process.env.SWARM_SESSION_SECRET = "test-receipt-secret-do-not-use";
  const receipt = signedReceipt();
  // Wrong secret -> signature failure.
  assert.deepEqual(verifyReceipt(receipt, "a-different-secret"), {
    ok: false,
    reason: "signature",
  });
  // No secret at verify time -> never verified.
  delete process.env.SWARM_SESSION_SECRET;
  assert.deepEqual(verifyReceipt(receipt), { ok: false, reason: "signature" });
});

test("verification fails for the wrong format and for malformed receipts", () => {
  const receipt = signedReceipt();
  assert.deepEqual(verifyReceipt({ ...receipt, format: "swarmagents.proof/v1" }), {
    ok: false,
    reason: "format",
  });
  assert.deepEqual(verifyReceipt({ ...receipt, format: "swarmagents.receipt/v2" }), {
    ok: false,
    reason: "format",
  });
  // Garbage -> never verified, never throws.
  assert.deepEqual(verifyReceipt(null), { ok: false, reason: "format" });
  assert.deepEqual(verifyReceipt("signed"), { ok: false, reason: "format" });
  assert.deepEqual(verifyReceipt({ ...receipt, links: "nope" }), {
    ok: false,
    reason: "format",
  });
  // Missing signature -> never verified.
  const { signature: _sig, ...unsigned } = receipt;
  assert.deepEqual(verifyReceipt(unsigned), { ok: false, reason: "signature" });
});

test("an empty chain has zero links, a genesis head, and verifies", () => {
  const { links, head } = buildReceiptChain([]);
  assert.equal(links.length, 0);
  assert.equal(head, GENESIS_PREV);
  assert.deepEqual(verifyReceiptChain(links), { ok: true });
  const receipt = signReceipt({
    format: RECEIPT_FORMAT,
    runId: "run_receipt_empty",
    createdAt: 1_700_000_000_000,
    head,
    links,
  });
  assert.deepEqual(verifyReceipt(receipt), { ok: true });
});

test("reordering links or breaking the prev pointer fails at the first bad link", () => {
  const receipt = signedReceipt();
  const swapped = structuredClone(receipt);
  [swapped.links[1], swapped.links[2]] = [swapped.links[2]!, swapped.links[1]!];
  assert.deepEqual(verifyReceipt(swapped), { ok: false, failedLink: 1, reason: "chain" });

  const brokenPrev = structuredClone(receipt);
  brokenPrev.links[3]!.prev = "f".repeat(64);
  assert.deepEqual(verifyReceipt(brokenPrev), { ok: false, failedLink: 3, reason: "chain" });
});
