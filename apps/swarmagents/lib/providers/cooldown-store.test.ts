import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { COOLDOWN_FILE_NAME, CooldownStore, configureCooldownFile, hashProviderKey } from "./cooldown-store";
import { Router } from "./router";
import type { FetchLike, ProviderConfig, ProviderKind } from "./types";

let tempHome: string;
let previousHome: string | undefined;

test.beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cooldowns-"));
  previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = tempHome;
  // The state file always lives under the temp SWARM_HOME of this test.
  configureCooldownFile(undefined);
});

test.afterEach(() => {
  if (previousHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function provider(
  id: string,
  kind: ProviderKind,
  keys: string[]
): ProviderConfig {
  return {
    id,
    kind,
    keys,
    rank: 0,
    models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const rateLimited: FetchLike = async () =>
  jsonResponse({ error: { message: "rate limited" } }, { status: 429 });

const userMessage = { role: "user" as const, content: "hello" };

function stateFile(): string {
  return path.join(tempHome, COOLDOWN_FILE_NAME);
}

function readState(): { version: number; entries: Record<string, unknown>[] } {
  return JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
}

test("hashProviderKey is stable, one-way and never contains the key", () => {
  const key = "sk-ant-hash-secret";
  const hash = hashProviderKey(key);
  assert.equal(hash.length, 32);
  assert.equal(hashProviderKey(key), hash, "the hash must be stable across restarts");
  assert.notEqual(hashProviderKey(`${key}-other`), hash);
  assert.equal(hash.includes(key), false);
});

test("persists a rate-limited key's cooldown under SWARM_HOME, never the key", async () => {
  const key = "sk-ant-persist-secret";
  const router = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: rateLimited,
    persistCooldowns: true,
  });

  await router.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});

  assert.ok(fs.existsSync(stateFile()), "the cooldown state must live under SWARM_HOME");
  const raw = fs.readFileSync(stateFile(), "utf-8");
  assert.equal(raw.includes(key), false, "key material must never be written to disk");

  const state = readState();
  assert.equal(state.version, 1);
  assert.equal(state.entries.length, 1);
  const entry = state.entries[0];
  assert.equal(entry.provider, "anthropic");
  assert.equal(entry.keyHash, hashProviderKey(key));
  assert.equal(entry.lastStatus, 429);
  assert.equal(entry.lastErrorKind, "rate_limit");
  assert.ok((entry.cooldownUntil as number) > Date.now());
});

test("restores the cooldown after a restart so the key is not hammered again", async () => {
  const key = "sk-ant-restart-secret";
  let calls = 0;
  const failing: FetchLike = async () => {
    calls += 1;
    return jsonResponse(
      { error: { message: "rate limited" } },
      { status: 429, headers: { "retry-after": "30" } }
    );
  };

  const first = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: failing,
    persistCooldowns: true,
  });
  await first.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});
  assert.equal(calls, 1);

  // A restarted process builds a brand new router from the persisted state.
  const second = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: failing,
    persistCooldowns: true,
  });

  const restored = second.stats().providers[0].keys[0];
  assert.equal(restored.available, false, "the cooldown must survive the restart");
  assert.ok((restored.cooldownUntil ?? 0) > Date.now());

  await second.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});
  assert.equal(calls, 1, "the rate-limited key must not be used again after a restart");
});

test("keeps the exponential backoff exponent across a restart", async () => {
  const key = "sk-ant-backoff-secret";
  let clock = 1_000;
  const failing: FetchLike = async () =>
    jsonResponse({ error: { message: "rate limited" } }, { status: 429 });

  const first = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: failing,
    now: () => clock,
    persistCooldowns: true,
  });
  await first.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});
  assert.equal(first.stats().providers[0].keys[0].cooldownUntil, 2_000);

  const second = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: failing,
    now: () => clock,
    persistCooldowns: true,
  });
  assert.equal(second.stats().providers[0].keys[0].cooldownUntil, 2_000);

  // Once the cooldown elapsed the key is used again and fails again: the
  // restored failure count makes the next backoff twice as long.
  clock = 2_500;
  await second.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});
  assert.equal(second.stats().providers[0].keys[0].cooldownUntil, 4_500);
});

test("prunes expired cooldown entries", async () => {
  const key = "sk-ant-expired-secret";
  fs.writeFileSync(
    stateFile(),
    JSON.stringify({
      version: 1,
      entries: [
        {
          provider: "anthropic",
          keyHash: hashProviderKey(key),
          cooldownUntil: Date.now() - 1_000,
          consecutiveFailures: 1,
          failures: 1,
          updatedAt: Date.now() - 1_000,
        },
      ],
    })
  );

  const router = new Router({
    providers: [provider("anthropic", "anthropic", [key])],
    fetch: async () => jsonResponse({ content: [] }),
    persistCooldowns: true,
  });

  assert.equal(
    router.stats().providers[0].keys[0].available,
    true,
    "an expired cooldown must not block the key"
  );
  assert.deepEqual(readState().entries, [], "expired entries must be pruned from the file");
});

test("a corrupt state file is ignored instead of breaking the router", async () => {
  fs.writeFileSync(stateFile(), "{ this is not json");

  const router = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-corrupt-secret"])],
    fetch: async () => jsonResponse({ content: [] }),
    persistCooldowns: true,
  });

  assert.equal(router.stats().providers[0].keys[0].available, true);
});

test("does not write any state when persistence is off", async () => {
  const explicit = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-disabled-secret"])],
    fetch: rateLimited,
    persistCooldowns: false,
  });

  await explicit.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});

  assert.equal(fs.existsSync(stateFile()), false);
  assert.equal(explicit.cooldownFile, undefined);

  // The default is off as well: the cooldown state is deployment-wide, so
  // only the long-lived server router opts into it.
  const byDefault = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-default-secret"])],
    fetch: rateLimited,
  });

  await byDefault.complete({ messages: [userMessage], tier: "fast" }).catch(() => {});

  assert.equal(fs.existsSync(stateFile()), false);
  assert.equal(byDefault.cooldownFile, undefined);
});

test("writes the state file atomically and leaves no temp files behind", () => {
  const store = new CooldownStore({ file: stateFile() });
  store.save([
    {
      provider: "anthropic",
      keyHash: hashProviderKey("sk-ant-atomic-secret"),
      cooldownUntil: Date.now() + 60_000,
      consecutiveFailures: 1,
      failures: 1,
      updatedAt: Date.now(),
    },
  ]);

  assert.deepEqual(fs.readdirSync(tempHome), [COOLDOWN_FILE_NAME]);
  const state = readState();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].provider, "anthropic");
});

test("the store round-trips records and drops expired ones on load", () => {
  let clock = 10_000;
  const store = new CooldownStore({ file: stateFile(), now: () => clock });

  store.save([
    {
      provider: "anthropic",
      keyHash: hashProviderKey("sk-ant-store-secret"),
      cooldownUntil: clock + 5_000,
      consecutiveFailures: 2,
      failures: 4,
      lastStatus: 429,
      lastErrorKind: "rate_limit",
      updatedAt: clock,
    },
  ]);

  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].consecutiveFailures, 2);
  assert.equal(loaded[0].lastStatus, 429);

  clock = 20_000;
  assert.deepEqual(store.load(), [], "expired records must not be restored");
  assert.deepEqual(readState().entries, [], "expired records must be pruned from the file");
});
