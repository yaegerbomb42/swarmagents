/**
 * Tests for PUT /api/providers/settings.
 *
 * Covers the Ollama base-URL SSRF validation (cloud metadata and arbitrary
 * internal hosts are refused, loopback stays allowed in local mode) and the
 * bounded-body 413 from the shared readJsonBody helper.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { configureProviderStorePaths } from "../../../../lib/providers/store";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-settings-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

function put(body: unknown): Promise<Response> {
  return PUT(
    new NextRequest("http://localhost/api/providers/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test("PUT rejects a cloud-metadata ollamaBaseUrl", async () => {
  const res = await put({ ollamaBaseUrl: "http://169.254.169.254:11434" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /metadata/i);
});

test("PUT rejects an internal-host ollamaBaseUrl in server mode", async () => {
  const prev = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_SERVER_MODE = "1";
  try {
    // Server mode refuses requests without the middleware-set user header,
    // so authenticate as the local owner for this check.
    const res = await PUT(
      new NextRequest("http://localhost/api/providers/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-swarm-user": "local" },
        body: JSON.stringify({ ollamaBaseUrl: "http://192.168.1.10:11434" }),
      }),
    );
    assert.equal(res.status, 400);
  } finally {
    if (prev === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prev;
  }
});

test("PUT rejects a public http ollamaBaseUrl", async () => {
  const res = await put({ ollamaBaseUrl: "http://ollama.example.com:11434" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /https/);
});

test("PUT accepts a loopback ollamaBaseUrl in local mode and persists it", async () => {
  const res = await put({ ollamaBaseUrl: "http://127.0.0.1:11434/" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ollamaBaseUrl?: string };
  assert.equal(body.ollamaBaseUrl, "http://127.0.0.1:11434");

  const saved = (await (await GET(new NextRequest("http://localhost/api/providers/settings"))).json()) as {
    ollamaBaseUrl?: string;
  };
  assert.equal(saved.ollamaBaseUrl, "http://127.0.0.1:11434");
});

test("PUT refuses an oversized JSON body with a 413", async () => {
  const res = await put(JSON.stringify({ ollamaBaseUrl: "http://127.0.0.1:11434", pad: "x".repeat(300 * 1024) }));
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Request body is too large.");
});
