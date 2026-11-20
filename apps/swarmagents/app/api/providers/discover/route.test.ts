/**
 * Tests for POST /api/providers/discover.
 *
 * Covers the consistency fixes: an unnormalized input id (e.g. "OpenAI")
 * must match the saved "openai" provider so discovered models persist, and the
 * legacy apiStyle aliases ("openai-compatible", "custom") must be accepted the
 * same way POST /api/providers accepts them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  configureProviderStorePaths,
  routerProviders,
  saveProvider,
} from "../../../../lib/providers/store";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-providers-discover-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function discover(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/providers/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function modelListFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model" },
            { id: "gpt-4o", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("discover with an unnormalized id matches the saved provider and persists models", async () => {
  saveProvider("local", {
    id: "openai",
    apiKey: "sk-openai-discover",
    baseUrl: "https://api.openai.com/v1",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = modelListFetch();
  try {
    // "OpenAI" (uncanonical) must match the saved "openai" provider.
    const res = await discover({ id: "OpenAI", baseUrl: "https://api.openai.com/v1", save: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; persisted?: boolean; models?: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.persisted, true, "discovered models should persist against the saved provider");
    assert.equal(body.models?.length, 2);

    const saved = routerProviders("local").find((p) => p.id === "openai");
    assert.ok(saved, "saved provider still exists");
    assert.deepEqual([...(saved.availableModels ?? [])].sort(), ["gpt-4o-mini", "gpt-4o"].sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discover accepts legacy apiStyle aliases instead of rejecting with 400", async () => {
  saveProvider("local", {
    id: "openai",
    apiKey: "sk-openai-discover",
    baseUrl: "https://api.openai.com/v1",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = modelListFetch();
  try {
    for (const alias of ["openai-compatible", "custom"]) {
      const res = await discover({
        id: "openai",
        apiStyle: alias,
        baseUrl: "https://api.openai.com/v1",
        save: false,
      });
      assert.equal(res.status, 200, `alias "${alias}" should be accepted, not 400`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
