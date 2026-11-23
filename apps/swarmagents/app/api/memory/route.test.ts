import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import { configureProviderStorePaths } from "../../../lib/providers/store";
import { userMemoryFilePath } from "../../../lib/memory/store";
import { DELETE, GET, POST } from "./route";
import { DELETE as DELETE_ONE, GET as GET_ONE } from "./[id]/route";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-memory-api-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

interface MemoryRequestInit {
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
  /** The account the request is made as (the middleware sets this header). */
  user?: string;
}

function request(path: string, init: MemoryRequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.user) headers.set(USER_HEADER, init.user);
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    body: init.body,
    headers,
  });
}

test("POST stores a memory, GET lists it, DELETE [id] removes it", async () => {
  const created = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "the user prefers dark mode", tags: ["preference"] }),
    }),
  );
  assert.equal(created.status, 201);
  const { memory } = (await created.json()) as { memory: { id: string; fact: string; tags: string[] } };
  assert.match(memory.id, /^mem_/);
  assert.deepEqual(memory.tags, ["preference"]);

  const listed = await GET(request("/api/memory", { user: ALICE }));
  assert.equal(listed.status, 200);
  const listBody = (await listed.json()) as { memories: Array<{ id: string }>; total: number };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.memories[0].id, memory.id);

  const one = await GET_ONE(request(`/api/memory/${memory.id}`, { user: ALICE }), {
    params: Promise.resolve({ id: memory.id }),
  });
  assert.equal(one.status, 200);

  const removed = await DELETE_ONE(request(`/api/memory/${memory.id}`, { method: "DELETE", user: ALICE }), {
    params: Promise.resolve({ id: memory.id }),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { forgotten: 1 });

  const missing = await DELETE_ONE(request(`/api/memory/${memory.id}`, { method: "DELETE", user: ALICE }), {
    params: Promise.resolve({ id: memory.id }),
  });
  assert.equal(missing.status, 404);
});

test("GET searches the account's memories", async () => {
  await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "prefers pnpm for package management" }),
    }),
  );
  await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "the deploy pipeline runs on fridays" }),
    }),
  );

  const hit = await GET(request("/api/memory?q=package%20manager", { user: ALICE }));
  const hitBody = (await hit.json()) as { memories: Array<{ fact: string }> };
  assert.equal(hitBody.memories.length, 1);
  assert.match(hitBody.memories[0].fact, /pnpm/);

  const miss = await GET(request("/api/memory?q=quantum%20chromodynamics", { user: ALICE }));
  const missBody = (await miss.json()) as { memories: unknown[] };
  assert.equal(missBody.memories.length, 0);
});

test("DELETE /api/memory clears every memory of the account only", async () => {
  for (const user of [ALICE, BOB]) {
    await POST(
      request("/api/memory", {
        method: "POST",
        user,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: `note for ${user}` }),
      }),
    );
  }

  const cleared = await DELETE(request("/api/memory", { method: "DELETE", user: ALICE }));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { forgotten: 1 });

  const aliceList = (await (await GET(request("/api/memory", { user: ALICE }))).json()) as { total: number };
  assert.equal(aliceList.total, 0);
  const bobList = (await (await GET(request("/api/memory", { user: BOB }))).json()) as { total: number };
  assert.equal(bobList.total, 1);
});

test("one account never sees another account's memories", async () => {
  const created = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "alice's private note" }),
    }),
  );
  const { memory } = (await created.json()) as { memory: { id: string } };

  const bobList = (await (await GET(request("/api/memory", { user: BOB }))).json()) as { total: number };
  assert.equal(bobList.total, 0);

  const bobRead = await GET_ONE(request(`/api/memory/${memory.id}`, { user: BOB }), {
    params: Promise.resolve({ id: memory.id }),
  });
  assert.equal(bobRead.status, 404);

  const bobDelete = await DELETE_ONE(request(`/api/memory/${memory.id}`, { method: "DELETE", user: BOB }), {
    params: Promise.resolve({ id: memory.id }),
  });
  assert.equal(bobDelete.status, 404);
});

test("a fact with a secret in it is redacted before it is stored", async () => {
  const secret = "sk-FAKE-API-KEY-0123456789ABCDEF0123456789";
  const created = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: `my key is ${secret}` }),
    }),
  );
  const { memory } = (await created.json()) as { memory: { fact: string } };
  assert.ok(!memory.fact.includes(secret));
  assert.match(memory.fact, /\[REDACTED\]/);
});

test("a memory without a fact is rejected", async () => {
  const res = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["preference"] }),
    }),
  );
  assert.equal(res.status, 400);
});

test("GET and DELETE [id] reject invalid id shapes with 404 and no-store", async () => {
  const badIds = ["not_a_mem_id", "mem_short", "mem_!@#$", "../etc/passwd"];
  for (const id of badIds) {
    const getRes = await GET_ONE(request(`/api/memory/${id}`, { user: ALICE }), {
      params: Promise.resolve({ id }),
    });
    assert.equal(getRes.status, 404);
    assert.equal(getRes.headers.get("cache-control"), "no-store");

    const delRes = await DELETE_ONE(request(`/api/memory/${id}`, { method: "DELETE", user: ALICE }), {
      params: Promise.resolve({ id }),
    });
    assert.equal(delRes.status, 404);
    assert.equal(delRes.headers.get("cache-control"), "no-store");
  }
});

test("POST returns a generic 500 when the memory store cannot be written", async () => {
  // memory.json as a directory: the atomic rename that commits the write
  // fails with EISDIR, and the raw errno text must never reach the client.
  const file = userMemoryFilePath(ALICE);
  mkdirSync(file, { recursive: true });
  const res = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "The sky is blue." }),
    }),
  );
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Could not store memory.");
  assert.equal(JSON.stringify(body).includes("memory.json"), false);
  assert.equal(JSON.stringify(body).includes("EISDIR"), false);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("DELETE returns a generic 500 when the memory store cannot be cleared", async (t) => {
  const created = await POST(
    request("/api/memory", {
      method: "POST",
      user: ALICE,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact: "Remember this." }),
    }),
  );
  assert.equal(created.status, 201);

  // Fail the atomic rename that commits the cleared file.
  const origRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes("memory.json")) {
      throw new Error("boom: rename failed at /tmp/internal/secret-path");
    }
    return origRename(from, to);
  });
  const res = await DELETE(request("/api/memory", { method: "DELETE", user: ALICE }));
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Could not clear memories.");
  assert.equal(JSON.stringify(body).includes("/tmp/internal/secret-path"), false);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("GET treats a corrupt memory file as empty instead of failing", async () => {
  const file = userMemoryFilePath(ALICE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{not json", "utf-8");
  const res = await GET(request("/api/memory", { user: ALICE }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { memories: unknown[]; total: number };
  assert.deepEqual(body.memories, []);
  assert.equal(body.total, 0);
});
