/**
 * Tests for DELETE/PATCH/GET /api/providers/[id].
 *
 * The whole point of these routes is key hygiene: a provider can be removed
 * and its keys added, rotated or dropped one at a time — and no response may
 * ever carry key material, only counts and last-4 masks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELETE, GET, PATCH } from "./route";
import {
  configureProviderStorePaths,
  readConfiguredProviders,
  routerProviders,
  saveProvider,
} from "../../../../lib/providers/store";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

let tempDir: string;
let providersFile: string;

const KEY_ONE = "sk-secret-one-aaaa";
const KEY_TWO = "sk-secret-two-bbbb";
const KEY_THREE = "sk-secret-three-cccc";

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-key-route-"));
  providersFile = join(tempDir, "providers.json");
  configureProviderStorePaths(providersFile);
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`http://localhost/api/providers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id)
  );
}

function del(id: string): Promise<Response> {
  return DELETE(
    new Request(`http://localhost/api/providers/${id}`, { method: "DELETE" }),
    ctx(id)
  );
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/providers/${id}`), ctx(id));
}

/** Requests without the user header act as the local-mode owner. */
const OWNER = "local";

function onDisk(): { providers: Array<{ id: string; keys?: string[] }> } {
  return { providers: readConfiguredProviders(OWNER) };
}

/** Assert a response body carries no key material. */
function assertNoKeyMaterial(text: string, keys: string[]): void {
  for (const key of keys) {
    assert.equal(text.includes(key), false, `response leaked the key "${key}"`);
  }
}

test("PATCH refuses a body over the 16kb cap with 413", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  const res = await PATCH(
    new Request("http://localhost/api/providers/openai", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add-key", apiKey: "sk-test", pad: "x".repeat(16 * 1024) }),
    }),
    ctx("openai"),
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Request body is too large.");
});

test("PATCH adds a single key and answers with counts and last-4 masks only", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });

  const res = await patch("openai", { action: "add-key", apiKey: KEY_TWO });
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoKeyMaterial(text, [KEY_ONE, KEY_TWO]);

  const body = JSON.parse(text) as {
    ok?: boolean;
    keyCount?: number;
    keySlots?: Array<{ index: number; mask: string }>;
    provider?: Record<string, unknown>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.keyCount, 2);
  assert.equal(body.provider?.keyCount, 2);
  assert.deepEqual(body.keySlots, [
    { index: 0, mask: "••••aaaa" },
    { index: 1, mask: "••••bbbb" },
  ]);

  // Both keys are on disk, in order.
  assert.deepEqual(onDisk().providers[0].keys, [KEY_ONE, KEY_TWO]);
});

test("PATCH removes a single key by index", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  saveProvider(OWNER, { id: "groq", apiKey: KEY_THREE });

  const res = await patch("openai", { action: "remove-key", index: 0 });
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoKeyMaterial(text, [KEY_ONE]);

  const body = JSON.parse(text) as { keyCount?: number; keySlots?: Array<{ mask: string }> };
  assert.equal(body.keyCount, 0);
  assert.deepEqual(body.keySlots, []);

  const providers = onDisk().providers;
  assert.deepEqual(providers.find((p) => p.id === "openai")?.keys, []);
  // Unrelated providers keep their keys.
  assert.deepEqual(providers.find((p) => p.id === "groq")?.keys, [KEY_THREE]);
});

test("PATCH removes the key at the requested index only", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  await patch("openai", { action: "add-key", apiKey: KEY_TWO });
  await patch("openai", { action: "add-key", apiKey: KEY_THREE });

  const res = await patch("openai", { action: "remove-key", index: 1 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { keyCount?: number };
  assert.equal(body.keyCount, 2);
  assert.deepEqual(onDisk().providers[0].keys, [KEY_ONE, KEY_THREE]);
});

test("PATCH rotates a key in place", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  await patch("openai", { action: "add-key", apiKey: KEY_TWO });

  const res = await patch("openai", { action: "rotate-key", index: 1, apiKey: KEY_THREE });
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoKeyMaterial(text, [KEY_ONE, KEY_TWO, KEY_THREE]);

  const body = JSON.parse(text) as { keyCount?: number; keySlots?: Array<{ mask: string }> };
  assert.equal(body.keyCount, 2);
  assert.deepEqual(body.keySlots, [
    { index: 0, mask: "••••aaaa" },
    { index: 1, mask: "••••cccc" },
  ]);
  assert.deepEqual(onDisk().providers[0].keys, [KEY_ONE, KEY_THREE]);
});

test("PATCH rejects unknown providers, bad indexes and bad payloads", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });

  assert.equal((await patch("nope", { action: "add-key", apiKey: KEY_TWO })).status, 404);
  assert.equal((await patch("openai", { action: "remove-key", index: 7 })).status, 400);
  assert.equal((await patch("openai", { action: "remove-key", index: -1 })).status, 400);
  assert.equal((await patch("openai", { action: "remove-key" })).status, 400);
  assert.equal((await patch("openai", { action: "banana" })).status, 400);
  assert.equal((await patch("openai", { action: "add-key" })).status, 400);
  assert.equal((await patch("openai", { action: "add-key", apiKey: "x".repeat(600) })).status, 400);
  assert.equal(
    (
      await PATCH(
        new Request("http://localhost/api/providers/openai", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{ not json",
        }),
        ctx("openai")
      )
    ).status,
    400
  );

  // Nothing changed on disk.
  assert.deepEqual(onDisk().providers[0].keys, [KEY_ONE]);
});

test("PATCH changes rank and order without touching the keys", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  saveProvider(OWNER, { id: "groq", apiKey: KEY_TWO });

  const set = await patch("openai", { action: "set-rank", rank: 0 });
  assert.equal(set.status, 200);
  const setBody = (await set.json()) as { rank?: number; provider?: Record<string, unknown> };
  assert.equal(setBody.rank, 0);
  assert.equal(setBody.provider?.keyCount, 1);
  assert.deepEqual(onDisk().providers.find((p) => p.id === "openai")?.keys, [KEY_ONE]);

  const moved = await patch("groq", { action: "move-up" });
  assert.equal(moved.status, 200);
  const movedBody = (await moved.json()) as { rank?: number };
  assert.equal(movedBody.rank, 2);
  assert.deepEqual(onDisk().providers.find((p) => p.id === "groq")?.keys, [KEY_TWO]);

  const shorthand = await patch("openai", { rank: 5 });
  assert.equal(shorthand.status, 200);
  assert.equal((await patch("openai", { action: "set-rank", rank: -1 })).status, 400);
  assert.equal((await patch("missing", { action: "move-down" })).status, 404);
});

test("DELETE removes the provider and its keys", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  saveProvider(OWNER, { id: "groq", apiKey: KEY_THREE });

  const res = await del("openai");
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoKeyMaterial(text, [KEY_ONE, KEY_THREE]);
  const body = JSON.parse(text) as { ok?: boolean; removed?: boolean; id?: string };
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.equal(body.id, "openai");

  const providers = onDisk().providers;
  assert.deepEqual(
    providers.map((p) => p.id),
    ["groq"]
  );
  // The provider is gone from the router set as well.
  assert.equal(
    routerProviders(OWNER).some((p) => p.id === "openai" && p.keys?.length),
    false
  );
});

test("DELETE of an unknown provider is a 404", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  const res = await del("does-not-exist");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /not found/i);
  // The existing provider is untouched.
  assert.deepEqual(onDisk().providers[0].keys, [KEY_ONE]);
});

test("DELETE refuses to touch a provider that was never saved", async () => {
  const res = await del("anthropic");
  assert.equal(res.status, 404);
  assert.deepEqual(readConfiguredProviders(OWNER), []);
});

test("GET returns one provider with counts and masks, never key material", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  const res = await get("openai");
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoKeyMaterial(text, [KEY_ONE]);
  const body = JSON.parse(text) as {
    provider?: { keyCount?: number; keySlots?: Array<{ mask: string }>; saved?: boolean };
  };
  assert.equal(body.provider?.keyCount, 1);
  assert.equal(body.provider?.saved, true);
  assert.deepEqual(body.provider?.keySlots, [{ index: 0, mask: "••••aaaa" }]);
});

test("GET of an unknown provider is a 404", async () => {
  const res = await get("nope");
  assert.equal(res.status, 404);
});

test("no provider response ever carries key material", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  await patch("openai", { action: "add-key", apiKey: KEY_TWO });
  const bodies = await Promise.all([
    get("openai").then((r) => r.text()),
    patch("openai", { action: "rotate-key", index: 0, apiKey: KEY_THREE }).then((r) => r.text()),
    patch("openai", { action: "remove-key", index: 1 }).then((r) => r.text()),
    del("openai").then((r) => r.text()),
  ]);
  for (const body of bodies) {
    assertNoKeyMaterial(body, [KEY_ONE, KEY_TWO, KEY_THREE]);
  }
});

test("key add/rotate/remove and provider delete are audit-logged, without key material", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });
  const auditFile = join(tempDir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    assert.equal((await patch("openai", { action: "add-key", apiKey: KEY_TWO })).status, 200);
    assert.equal((await patch("openai", { action: "rotate-key", index: 1, apiKey: KEY_THREE })).status, 200);
    assert.equal((await patch("openai", { action: "remove-key", index: 0 })).status, 200);
    assert.equal((await del("openai")).status, 200);

    const entries = readAuditEntries(OWNER);
    assert.deepEqual(
      entries.map((e) => e.action),
      ["provider.delete", "provider.key.remove", "provider.key.rotate", "provider.key.add"],
      "audit entries are newest first",
    );
    assert.ok(entries.every((e) => e.target === "openai"));
    assert.ok(entries.every((e) => e.result === "success"));
    const logged = entries.map((e) => JSON.stringify(e)).join("\n");
    assertNoKeyMaterial(logged, [KEY_ONE, KEY_TWO, KEY_THREE]);
  } finally {
    configureAuditPath(undefined);
  }
});

test("GET, PATCH and DELETE resolve mixed-case IDs (e.g. 'OpenAI')", async () => {
  saveProvider(OWNER, { id: "openai", apiKey: KEY_ONE });

  const getRes = await get("OpenAI");
  assert.equal(getRes.status, 200);
  const getData = (await getRes.json()) as { provider?: { id?: string } };
  assert.equal(getData.provider?.id, "openai");

  const patchRes = await patch("OpenAI", { action: "add-key", apiKey: KEY_TWO });
  assert.equal(patchRes.status, 200);

  const delRes = await del("OpenAI");
  assert.equal(delRes.status, 200);
  const delData = (await delRes.json()) as { ok?: boolean; id?: string };
  assert.equal(delData.ok, true);
  assert.equal(delData.id, "openai");
});
