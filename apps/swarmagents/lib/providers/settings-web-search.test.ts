/**
 * Unit tests for the webSearch settings field (lib/providers/settings.ts):
 * defensive parsing of the per-user web-search config and persistence
 * round-trips. Mirrors settings.test.ts setup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "./store";
import {
  parseUserSettings,
  parseWebSearchConfig,
  readUserSettings,
  updateUserSettings,
} from "./settings";

const U = "local_tester@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-settings-web-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("parseWebSearchConfig accepts a valid config and trims the key", () => {
  assert.deepEqual(parseWebSearchConfig({ backend: "brave", apiKey: "  key-1  " }), {
    backend: "brave",
    apiKey: "key-1",
  });
  assert.deepEqual(parseWebSearchConfig({ backend: "searxng", searxngUrl: "https://searx.example.com/" }), {
    backend: "searxng",
    searxngUrl: "https://searx.example.com",
  });
});

test("parseWebSearchConfig rejects unknown backends and junk shapes", () => {
  assert.equal(parseWebSearchConfig(null), undefined);
  assert.equal(parseWebSearchConfig("brave"), undefined);
  assert.equal(parseWebSearchConfig({ backend: "duckduckgo", apiKey: "k" }), undefined);
  assert.equal(parseWebSearchConfig({ apiKey: "k" }), undefined);
});

test("parseWebSearchConfig drops individually invalid fields, keeps the backend", () => {
  assert.deepEqual(parseWebSearchConfig({ backend: "tavily", apiKey: 42, searxngUrl: "not a url" }), {
    backend: "tavily",
  });
  assert.deepEqual(
    parseWebSearchConfig({ backend: "exa", apiKey: "x".repeat(600), searxngUrl: "ftp://searx.example.com" }),
    { backend: "exa" },
  );
  assert.deepEqual(
    parseWebSearchConfig({ backend: "searxng", searxngUrl: "https://user:pass@searx.example.com" }),
    { backend: "searxng" },
  );
});

test("parseUserSettings carries webSearch through; absent stays absent", () => {
  assert.equal(parseUserSettings({ preferFreeProviders: true }).webSearch, undefined);
  const parsed = parseUserSettings({
    preferFreeProviders: false,
    webSearch: { backend: "exa", apiKey: "exa-key" },
  });
  assert.deepEqual(parsed.webSearch, { backend: "exa", apiKey: "exa-key" });
});

test("webSearch persists per-user and merges on update", () => {
  updateUserSettings(U, { webSearch: { backend: "brave", apiKey: "key-a" } });
  assert.deepEqual(readUserSettings(U).webSearch, { backend: "brave", apiKey: "key-a" });

  updateUserSettings(U, { webSearch: { backend: "searxng", searxngUrl: "https://searx.example.com" } });
  assert.deepEqual(readUserSettings(U).webSearch, {
    backend: "searxng",
    searxngUrl: "https://searx.example.com",
  });

  // Other settings updates do not clobber the search config.
  updateUserSettings(U, { preferFreeProviders: false });
  assert.equal(readUserSettings(U).webSearch?.backend, "searxng");
});
