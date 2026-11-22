/**
 * Tests for the BYOC pairing codes and device tokens.
 *
 * Covers the security properties that matter: a pairing code is single use
 * and short lived, the device token is stored hashed (never in clear), and a
 * revoked device can never authenticate again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ByocTokenStore,
  formatPairingCode,
  hashSecret,
  normalizePairingCode,
} from "./tokens";

function tempStore(now?: () => number): { store: ByocTokenStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-tokens-"));
  const file = path.join(dir, "byoc.json");
  return { store: new ByocTokenStore({ file, now }), file };
}

test("pairing codes are one-time and expire", () => {
  const { store } = tempStore();
  const { code } = store.createPairingCode("alice");
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const first = store.redeemPairingCode(code, "my-laptop");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.device.userId, "alice");
  assert.equal(first.device.name, "my-laptop");
  assert.ok(first.token.length > 20, "expected a long random token");

  // The same code cannot be redeemed twice.
  const second = store.redeemPairingCode(code, "my-laptop");
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error, "used");
});

test("a pairing code cannot be redeemed by another account", () => {
  const { store } = tempStore();
  const { code } = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code, "my-laptop");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  // The device belongs to alice, never to bob.
  assert.equal(paired.device.userId, "alice");
  assert.deepEqual(store.listDevices("bob"), []);
});

test("expired pairing codes are refused", () => {
  let clock = 1_000;
  const { store } = tempStore(() => clock);
  const { code, expiresAt } = store.createPairingCode("alice", 1_000);
  assert.equal(expiresAt, 2_000);
  clock = 5_000;
  const paired = store.redeemPairingCode(code, "my-laptop");
  assert.equal(paired.ok, false);
  if (paired.ok) return;
  assert.equal(paired.error, "expired");
});

test("device tokens are stored hashed, never in clear", () => {
  const { store, file } = tempStore();
  const { code } = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code, "my-laptop");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(paired.token), "the token must not be written to disk in clear");
  assert.ok(raw.includes(hashSecret(paired.token)), "the hash of the token is stored instead");

  const verified = store.verifyToken(paired.token);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.device.id, paired.device.id);
});

test("an unknown token is refused and a revoked device cannot authenticate", () => {
  const { store } = tempStore();
  const { code } = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code, "my-laptop");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const bogus = store.verifyToken("not-a-real-token");
  assert.equal(bogus.ok, false);
  if (bogus.ok) return;
  assert.equal(bogus.error, "invalid");

  assert.equal(store.revokeDevice("alice", paired.device.id), true);
  const revoked = store.verifyToken(paired.token);
  assert.equal(revoked.ok, false);
  if (revoked.ok) return;
  assert.equal(revoked.error, "revoked");

  // Another account cannot revoke it, and the device stays revoked.
  assert.equal(store.revokeDevice("bob", paired.device.id), false);
  assert.equal(store.getDevice("alice", paired.device.id)?.revokedAt !== undefined, true);
});

test("pairing codes are normalized before they are compared", () => {
  assert.equal(normalizePairingCode("abcd-2345"), "ABCD2345");
  assert.equal(normalizePairingCode(" ab cd 23 45 "), "ABCD2345");
  assert.equal(formatPairingCode("ABCD2345"), "ABCD-2345");
});

test("the store survives a restart", () => {
  const { store, file } = tempStore();
  const { code } = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code, "my-laptop");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const reloaded = new ByocTokenStore({ file });
  const verified = reloaded.verifyToken(paired.token);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.device.name, "my-laptop");
});

test("createPairingCode stores preferredName and redeem falls back to it", () => {
  const { store } = tempStore();
  const { code, name } = store.createPairingCode("alice", { name: "studio" });
  assert.equal(name, "studio");
  const paired = store.redeemPairingCode(code, "");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(paired.device.name, "studio");
});

