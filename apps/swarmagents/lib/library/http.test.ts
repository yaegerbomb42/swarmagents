/**
 * Shared Library HTTP helpers: identity resolution, bounded JSON bodies and
 * error mapping that never echoes secret data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { USER_HEADER } from "../auth";
import {
  MAX_BODY_BYTES,
  errorResponse,
  jsonError,
  libraryOwner,
  readJson,
  routeParam,
  unauthorized,
} from "./http";
import { LibraryError } from "./types";

const savedEnv = { ...process.env };

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function jsonRequest(body: string): Request {
  return new Request("http://library.test/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// ---- identity --------------------------------------------------------------

test("libraryOwner trusts the middleware-provided user header", () => {
  delete process.env.SWARM_SERVER_MODE;
  const request = new Request("http://library.test", { headers: { [USER_HEADER]: "alice" } });
  assert.equal(libraryOwner(request), "alice");
});

test("server-mode requests without an identity are anonymous", () => {
  process.env.SWARM_SERVER_MODE = "1";
  const request = new Request("http://library.test");
  assert.equal(libraryOwner(request), null);

  const invalid = new Request("http://library.test", { headers: { [USER_HEADER]: "" } });
  assert.equal(libraryOwner(invalid), null);
});

test("local mode falls back to the single local account", () => {
  delete process.env.SWARM_SERVER_MODE;
  assert.equal(libraryOwner(new Request("http://library.test")), "local");
});

// ---- bounded JSON ----------------------------------------------------------

test("readJson parses an object body", async () => {
  assert.deepEqual(await readJson(jsonRequest('{"kind":"skill"}')), { kind: "skill" });
});

test("readJson treats an empty body as an empty object", async () => {
  assert.deepEqual(await readJson(jsonRequest("")), {});
  assert.deepEqual(await readJson(jsonRequest("   \n ")), {});
});

test("readJson rejects malformed JSON and unreadable bodies with 400", async () => {
  await assert.rejects(
    () => readJson(jsonRequest("{ not json")),
    (error: unknown) => error instanceof LibraryError && error.status === 400 && /Invalid JSON/.test(error.message),
  );

  const broken = {
    text: async () => {
      throw new Error("stream closed");
    },
  } as unknown as Request;
  await assert.rejects(
    () => readJson(broken),
    (error: unknown) => error instanceof LibraryError && error.status === 400 && /Could not read/.test(error.message),
  );
});

test("readJson enforces the byte cap before parsing", async () => {
  await assert.rejects(
    () => readJson(jsonRequest(JSON.stringify({ data: "x" })), 5),
    (error: unknown) => error instanceof LibraryError && error.status === 413 && /too large/.test(error.message),
  );
  assert.equal(MAX_BODY_BYTES, 256 * 1024);
});

// ---- responses -------------------------------------------------------------

test("unauthorized and jsonError set no-store and the requested status", async () => {
  const denied = unauthorized();
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.deepEqual(await denied.json(), { error: "Sign in required." });

  const bad = jsonError("Missing field.", 422, { missingFields: ["TOKEN"] });
  assert.equal(bad.status, 422);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  assert.deepEqual(await bad.json(), { error: "Missing field.", missingFields: ["TOKEN"] });
});

test("errorResponse maps LibraryError status and details", async () => {
  const response = errorResponse(new LibraryError("Missing.", 409, { missingFields: ["A"] }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "Missing.");
  assert.deepEqual(body.missingFields, ["A"]);
});

test("errorResponse maps an unexpected error to a generic 500 without its message", async () => {
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const response = errorResponse(new Error("database password hunter2"));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "The library request failed.");
    assert.equal(JSON.stringify(body).includes("hunter2"), false, "the response never echoes internals");
    assert.equal(logged.length, 1);
  } finally {
    console.error = originalError;
  }
});

// ---- route params ----------------------------------------------------------

test("routeParam accepts both Next 15 promise params and plain objects", async () => {
  assert.equal(await routeParam({ params: Promise.resolve({ id: "abc" }) }), "abc");
  assert.equal(await routeParam({ params: { id: "abc" } }), "abc");
  assert.equal(await routeParam({ params: Promise.resolve({} as { id: string }) }), "");
  assert.equal(await routeParam({ params: { id: 7 as unknown as string } }), "");
});
