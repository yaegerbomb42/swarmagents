/**
 * Per-user isolation and encryption at rest for the provider store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addProviderKey,
  configureProviderStorePaths,
  countUserProviders,
  ProviderMutationError,
  readConfiguredProviders,
  removeProvider,
  routerProviders,
  saveProvider,
  savedProviderIds,
  userProviderDir,
  userProvidersFilePath,
} from "./store";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
const ALICE_KEY = "sk-alice-secret-aaaa1111";
const BOB_KEY = "sk-bob-secret-bbbb2222";

let tempDir: string;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-per-user-store-"));
  configureProviderStorePaths(path.join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("each user only ever sees their own providers", () => {
  saveProvider(ALICE, { id: "openai", apiKey: ALICE_KEY });
  saveProvider(BOB, { id: "groq", apiKey: BOB_KEY });

  assert.deepEqual(savedProviderIds(ALICE), ["openai"]);
  assert.deepEqual(savedProviderIds(BOB), ["groq"]);
  assert.deepEqual(readConfiguredProviders(ALICE)[0].keys, [ALICE_KEY]);
  assert.deepEqual(readConfiguredProviders(BOB)[0].keys, [BOB_KEY]);

  const aliceRouter = routerProviders(ALICE, { hostEnvKeys: false });
  const bobRouter = routerProviders(BOB, { hostEnvKeys: false });
  assert.equal(JSON.stringify(aliceRouter).includes(BOB_KEY), false);
  assert.equal(JSON.stringify(bobRouter).includes(ALICE_KEY), false);
  assert.equal(aliceRouter.some((p) => p.id === "groq"), false);
  assert.equal(countUserProviders(ALICE), 1);
  assert.equal(countUserProviders("local_nobody@example.com"), 0);
});

test("a user cannot mutate or delete another user's provider", () => {
  saveProvider(ALICE, { id: "openai", apiKey: ALICE_KEY });
  assert.throws(() => addProviderKey(BOB, "openai", "sk-bob-injected"), (err: unknown) => {
    return err instanceof ProviderMutationError && err.status === 404;
  });
  assert.throws(() => removeProvider(BOB, "openai"), ProviderMutationError);
  assert.deepEqual(readConfiguredProviders(ALICE)[0].keys, [ALICE_KEY]);
});

test("same provider id in two accounts stays separate", () => {
  saveProvider(ALICE, { id: "openai", apiKey: ALICE_KEY });
  saveProvider(BOB, { id: "openai", apiKey: BOB_KEY });
  removeProvider(BOB, "openai");
  assert.deepEqual(readConfiguredProviders(ALICE)[0].keys, [ALICE_KEY]);
  assert.deepEqual(readConfiguredProviders(BOB), []);
});

test("keys are encrypted at rest in a mode-600 file inside a mode-700 dir", () => {
  const file = saveProvider(ALICE, { id: "openai", apiKey: ALICE_KEY }).file;
  assert.equal(file, userProvidersFilePath(ALICE));
  const text = fs.readFileSync(file, "utf-8");
  assert.equal(text.includes(ALICE_KEY), false, "plaintext key on disk");
  assert.equal(text.includes(ALICE_KEY.slice(-8)), false);
  const data = JSON.parse(text) as { version: number; userId: string; providers: Array<Record<string, unknown>> };
  assert.equal(data.version, 2);
  assert.equal(data.userId, ALICE);
  assert.equal("keys" in data.providers[0], false);
  assert.equal((data.providers[0].sealedKeys as string[]).length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(userProviderDir(ALICE)).mode & 0o777, 0o700);
});

test("a file copied into another user's directory is refused (owner mismatch)", () => {
  saveProvider(ALICE, { id: "openai", apiKey: ALICE_KEY });
  const bobFile = userProvidersFilePath(BOB);
  fs.mkdirSync(path.dirname(bobFile), { recursive: true });
  fs.copyFileSync(userProvidersFilePath(ALICE), bobFile);
  const errors = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(readConfiguredProviders(BOB), []);
    // Even with the owner field rewritten, the sealed key is bound to Alice.
    const data = JSON.parse(fs.readFileSync(bobFile, "utf-8")) as { userId: string };
    data.userId = BOB;
    fs.writeFileSync(bobFile, JSON.stringify(data));
    const stolen = readConfiguredProviders(BOB);
    assert.equal(stolen.length, 1);
    assert.deepEqual(stolen[0].keys, [], "Alice's sealed key must not open for Bob");
  } finally {
    console.error = errors;
  }
});

test("server mode never hands host env keys (SWARM_KEYS_*) to an account", () => {
  const prev = process.env.SWARM_KEYS_ANTHROPIC;
  process.env.SWARM_KEYS_ANTHROPIC = "sk-host-anthropic-shared";
  try {
    const serverView = routerProviders(BOB, { hostEnvKeys: false });
    const anthropic = serverView.find((p) => p.id === "anthropic");
    assert.deepEqual(anthropic?.keys, [], "explicit empty key list blocks the env fallback");
    // Local (single-user) mode keeps the machine's env keys.
    const localView = routerProviders("local", { hostEnvKeys: true });
    assert.equal(localView.find((p) => p.id === "anthropic")?.keys, undefined);
  } finally {
    if (prev === undefined) delete process.env.SWARM_KEYS_ANTHROPIC;
    else process.env.SWARM_KEYS_ANTHROPIC = prev;
  }
});

test("hostEnvKeys defaults off in server mode", () => {
  const prev = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_SERVER_MODE = "1";
  try {
    assert.deepEqual(routerProviders(BOB).find((p) => p.id === "openai")?.keys, []);
  } finally {
    if (prev === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prev;
  }
});

test("a missing or oversized user id is refused", () => {
  assert.throws(() => saveProvider("", { id: "openai", apiKey: ALICE_KEY }), ProviderMutationError);
  assert.throws(() => readConfiguredProviders("x".repeat(300)), ProviderMutationError);
});
