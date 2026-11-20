import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeKeyId, isSealed, open, seal, sealedKeyId, SecretBoxError } from "./secret-box";

const KEY = "sk-live-round-trip-0123456789";

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-secret-box-"));
}

test("AES-256-GCM round-trip under SWARM_KEYS_SECRET", () => {
  const env = { SWARM_KEYS_SECRET: "keys-secret-a" };
  const sealed = seal(KEY, "local_alice@example.com", "openai", { env });
  assert.ok(isSealed(sealed));
  assert.equal(sealedKeyId(sealed), "k");
  assert.equal(sealed.includes(KEY), false);
  assert.equal(open(sealed, "local_alice@example.com", "openai", { env }), KEY);
});

test("every seal uses a fresh IV (same plaintext, different ciphertext)", () => {
  const env = { SWARM_KEYS_SECRET: "keys-secret-a" };
  assert.notEqual(seal(KEY, "u", "p", { env }), seal(KEY, "u", "p", { env }));
});

test("a sealed key is bound to its owner and provider", () => {
  const env = { SWARM_KEYS_SECRET: "keys-secret-a" };
  const sealed = seal(KEY, "local_alice@example.com", "openai", { env });
  assert.throws(() => open(sealed, "local_bob@example.com", "openai", { env }), SecretBoxError);
  assert.throws(() => open(sealed, "local_alice@example.com", "groq", { env }), SecretBoxError);
});

test("a wrong secret or a tampered ciphertext never decrypts", () => {
  const sealed = seal(KEY, "u", "p", { env: { SWARM_KEYS_SECRET: "keys-secret-a" } });
  assert.throws(() => open(sealed, "u", "p", { env: { SWARM_KEYS_SECRET: "keys-secret-b" } }), SecretBoxError);
  const parts = sealed.split(".");
  const ct = Buffer.from(parts[3], "base64url");
  ct[0] ^= 0xff;
  parts[3] = ct.toString("base64url");
  assert.throws(() => open(parts.join("."), "u", "p", { env: { SWARM_KEYS_SECRET: "keys-secret-a" } }), SecretBoxError);
  assert.throws(() => open("not-sealed", "u", "p", { env: { SWARM_KEYS_SECRET: "keys-secret-a" } }), SecretBoxError);
});

test("falls back to an HKDF of SWARM_SESSION_SECRET (with a warning) when SWARM_KEYS_SECRET is unset", () => {
  const env = { SWARM_SESSION_SECRET: "session-secret" };
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    assert.equal(activeKeyId({ env }), "s");
    const sealed = seal(KEY, "u", "p", { env });
    assert.equal(sealedKeyId(sealed), "s");
    assert.equal(open(sealed, "u", "p", { env }), KEY);
  } finally {
    console.warn = warn;
  }
  // The warning fires at most once per process; it may already have fired.
  assert.ok(warnings.every((w) => w.includes("SWARM_KEYS_SECRET")));
  // The session-derived key is not the session secret used as-is for keys:
  // a SWARM_KEYS_SECRET with the same value seals under a different key.
  const sameValue = seal(KEY, "u", "p", { env: { SWARM_KEYS_SECRET: "session-secret" } });
  assert.throws(() => open(sameValue.replace(".k.", ".s."), "u", "p", { env }), SecretBoxError);
});

test("keys sealed under the session fallback still open after SWARM_KEYS_SECRET is added", () => {
  const before = { SWARM_SESSION_SECRET: "session-secret" };
  const sealed = seal(KEY, "u", "p", { env: before });
  const after = { SWARM_SESSION_SECRET: "session-secret", SWARM_KEYS_SECRET: "new-keys-secret" };
  assert.equal(open(sealed, "u", "p", { env: after }), KEY);
  assert.equal(sealedKeyId(seal(KEY, "u", "p", { env: after })), "k");
});

test("with no secrets at all, a generated mode-600 key file is used", () => {
  const d = dir();
  try {
    const sealed = seal(KEY, "u", "p", { env: {}, dataDir: d });
    assert.equal(sealedKeyId(sealed), "f");
    const keyFile = path.join(d, ".provider-keys.secret");
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(open(sealed, "u", "p", { env: {}, dataDir: d }), KEY);
    // Losing the key file makes the keys unreadable rather than silently wrong.
    fs.rmSync(keyFile);
    assert.throws(() => open(sealed, "u", "p", { env: {}, dataDir: d }), SecretBoxError);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
