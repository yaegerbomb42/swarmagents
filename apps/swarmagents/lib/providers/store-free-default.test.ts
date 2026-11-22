/**
 * Tests for free-tier flag defaulting: saveProvider seeds isFree from the
 * catalog (explicit input and previously saved values win), and
 * routerProviders overlays the catalog mark onto built-in defaults and
 * older saved configs that never carried the flag.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureProviderStorePaths,
  routerProviders,
  saveProvider,
} from "./store";

const U = "local_tester@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-providers-free-default-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("saveProvider seeds isFree from the catalog for free-tier providers", () => {
  const { config } = saveProvider(U, { id: "groq", apiKey: "gsk-test-key" });
  assert.equal(config.isFree, true);
});

test("saveProvider leaves isFree unset for paid providers", () => {
  const { config } = saveProvider(U, { id: "anthropic", apiKey: "sk-ant-test-key" });
  assert.equal(config.isFree, undefined);
});

test("an explicit isFree wins over the catalog mark", () => {
  const { config } = saveProvider(U, { id: "groq", apiKey: "gsk-test-key", isFree: false });
  assert.equal(config.isFree, false);
});

test("re-saving without isFree preserves the previous value", () => {
  saveProvider(U, { id: "groq", apiKey: "gsk-test-key", isFree: false });
  const { config } = saveProvider(U, { id: "groq", apiKey: "gsk-test-key-2" });
  assert.equal(config.isFree, false, "an edit must not reset the user's billing flag");
});

test("routerProviders overlays the catalog mark onto built-in defaults", () => {
  const providers = routerProviders(U);
  const gemini = providers.find((p) => p.id === "gemini");
  assert.ok(gemini, "gemini is a built-in default");
  assert.equal(gemini.isFree, true);
  const anthropic = providers.find((p) => p.id === "anthropic");
  assert.equal(anthropic?.isFree, undefined);
});

test("routerProviders keeps an explicit saved isFree over the overlay", () => {
  saveProvider(U, { id: "gemini", apiKey: "gemini-test-key", isFree: false });
  const gemini = routerProviders(U).find((p) => p.id === "gemini");
  assert.equal(gemini?.isFree, false);
});
