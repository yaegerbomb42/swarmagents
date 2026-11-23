// Tests for POST /api/runtime/vault/<token>/proxy — the VM-facing hop.
// The body-parsing cases never reach the vault: an oversized body is
// rejected with 413, malformed/empty bodies with 400, and a missing
// secretId/url with 400. A well-formed small body flows through to the
// proxy, which rejects the unknown token with 401 without any network.

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "../../../../../../lib/http";

function post(body: string): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/runtime/vault/tok123/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ token: "tok123" }) },
  );
}

test("vault proxy rejects an oversized body with 413", async () => {
  const huge = JSON.stringify({
    secretId: "sec_1",
    url: "https://example.test/hook",
    padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024),
  });
  const res = await post(huge);
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("vault proxy rejects malformed and empty bodies with 400", async () => {
  for (const bad of ["{not json", ""]) {
    const res = await post(bad);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error?: string };
    assert.equal(data.error, "JSON body required.");
  }
});

test("vault proxy rejects a body without secretId/url with 400", async () => {
  const res = await post(JSON.stringify({ url: "https://example.test/hook" }));
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.equal(data.error, "secretId and url are required.");
});

test("vault proxy passes a well-formed body through to the proxy (401 for an unknown token)", async () => {
  const res = await post(
    JSON.stringify({ secretId: "sec_1", url: "https://example.test/hook" }),
  );
  assert.equal(res.status, 401);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /Vault token/i);
});
