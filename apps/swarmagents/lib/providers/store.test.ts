import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureProviderStorePaths,
  resolveDataDir,
  getLegacyProvidersFilePath,
  userProvidersFilePath,
  normalizeProviderId,
  readConfiguredProviders,
  routerProviders,
  saveProvider,
  setProviderRank,
  moveProviderRank,
  savedProviderIds,
  tierModels,
  writeConfiguredProviders,
  addProviderKey,
  removeProviderKey,
  rotateProviderKey,
  removeProvider,
  ProviderMutationError,
} from "./store";
import { defaultProviderConfigs } from "./router";

/** The account these tests act as. */
const U = "local_tester@example.com";

let tempDir: string;
let providersFile: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-providers-store-"));
  providersFile = join(tempDir, "providers.json");
  configureProviderStorePaths(providersFile);
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("getLegacyProvidersFilePath uses the configured path, else SWARM_PROVIDERS_FILE", () => {
  assert.equal(getLegacyProvidersFilePath(), providersFile);
  configureProviderStorePaths("overridden.json");
  assert.equal(getLegacyProvidersFilePath(), "overridden.json");
  configureProviderStorePaths("");
  assert.equal(
    getLegacyProvidersFilePath({ env: { SWARM_PROVIDERS_FILE: "/tmp/custom-providers.json" } }),
    "/tmp/custom-providers.json"
  );
  configureProviderStorePaths(providersFile);
});

test("per-user files live under users/<hash>/ inside the data dir, never at the legacy path", () => {
  const file = userProvidersFilePath(U);
  assert.ok(file.startsWith(join(tempDir, "users")), file);
  assert.notEqual(file, providersFile);
  assert.equal(file.includes("tester@example.com"), false, "the user id never becomes a path");
});

test("readConfiguredProviders returns [] when no file exists", () => {
  assert.deepEqual(readConfiguredProviders(U), []);
});

test("writeConfiguredProviders persists valid file content", () => {
  const configs = [
    { id: "deepseek", kind: "openai" as const, baseUrl: "https://api.deepseek.com/v1", keys: ["sk-test"] },
  ];
  const file = writeConfiguredProviders(U, configs);
  assert.equal(file, userProvidersFilePath(U));
  assert.equal(readFileSync(file, "utf-8").includes("sk-test"), false, "keys are encrypted at rest");
  const onDisk = readConfiguredProviders(U);
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, "deepseek");
  assert.equal(onDisk[0].kind, "openai");
  assert.equal(onDisk[0].baseUrl, "https://api.deepseek.com/v1");
  assert.deepEqual(onDisk[0].keys, ["sk-test"]);
});

test("saveProvider writes a keyed provider, encrypted at rest", () => {
  const { config, file } = saveProvider(U, {
    id: "openai",
    apiKey: "sk-openai-secret-123",
  });
  assert.equal(config.id, "openai");
  assert.equal(config.kind, "openai");
  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(config.keys, ["sk-openai-secret-123"]);
  assert.equal(config.enabled, true);

  assert.equal(readFileSync(file, "utf-8").includes("sk-openai-secret-123"), false);
  const onDisk = readConfiguredProviders(U);
  assert.equal(onDisk.length, 1);
  assert.deepEqual(onDisk[0].keys, ["sk-openai-secret-123"]);
});

test("saveProvider upserts: re-saving replaces the key for the same id", () => {
  saveProvider(U, { id: "anthropic", apiKey: "sk-ant-first" });
  const { config } = saveProvider(U, { id: "anthropic", apiKey: "sk-ant-second" });

  const onDisk = readConfiguredProviders(U);
  assert.equal(onDisk.length, 1);
  assert.deepEqual(config.keys, ["sk-ant-second"]);
  assert.deepEqual(onDisk[0].keys, ["sk-ant-second"]);
});

test("saveProvider preserves rank when the provider is edited without one", () => {
  const first = saveProvider(U, { id: "openai", apiKey: "sk-openai-first", rank: 7 });
  assert.equal(first.config.rank, 7);

  // The UI omits rank on a plain re-save; the existing order must survive.
  const second = saveProvider(U, { id: "openai", apiKey: "sk-openai-second" });
  assert.equal(second.config.rank, 7);
  assert.equal(readConfiguredProviders(U)[0].rank, 7);

  const explicit = saveProvider(U, { id: "openai", apiKey: "sk-openai-third", rank: 2 });
  assert.equal(explicit.config.rank, 2);
});

test("saveProvider rejects a negative rank", () => {
  assert.throws(
    () => saveProvider(U, { id: "openai", apiKey: "sk-openai", rank: -1 }),
    /greater than or equal to 0/
  );
  assert.deepEqual(readConfiguredProviders(U), []);
});

test("setProviderRank ranks a built-in without shadowing its env keys", () => {
  const ranked = setProviderRank(U, "anthropic", 9);
  assert.equal(ranked.id, "anthropic");
  assert.equal(ranked.rank, 9);
  assert.equal(ranked.keys, undefined, "a rank-only entry must not create an empty key array");

  const onDisk = readConfiguredProviders(U).find((p) => p.id === "anthropic");
  assert.equal(onDisk?.rank, 9);
  assert.equal(onDisk?.keys, undefined);

  const merged = routerProviders(U).find((p) => p.id === "anthropic");
  assert.equal(merged?.rank, 9);
  assert.equal(merged?.keys, undefined, "environment keys still apply");
});

test("moveProviderRank swaps adjacent providers and normalizes ranks", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-openai", rank: 10 });
  saveProvider(U, { id: "groq", apiKey: "gsk-groq", rank: 11 });
  const ranked = () =>
    [...routerProviders(U)].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  moveProviderRank(U, "openai", "up");
  assert.deepEqual(
    ranked().map((p) => p.id),
    ["anthropic", "openai", "gemini", "groq"]
  );
  assert.deepEqual(
    ranked().map((p) => p.rank),
    [0, 1, 2, 3]
  );

  moveProviderRank(U, "openai", "down");
  assert.deepEqual(
    ranked().map((p) => p.id),
    ["anthropic", "gemini", "openai", "groq"]
  );
});

test("rank mutations reject bad ranks and unknown providers", () => {
  assert.throws(() => setProviderRank(U, "anthropic", -1), ProviderMutationError);
  assert.throws(() => setProviderRank(U, "nope", 1), ProviderMutationError);
  assert.throws(() => moveProviderRank(U, "nope", "up"), ProviderMutationError);
  assert.throws(() => moveProviderRank(U, "anthropic", "up"), ProviderMutationError);
});

test("saveProvider keeps unrelated configured providers", () => {
  saveProvider(U, { id: "anthropic", apiKey: "sk-ant" });
  saveProvider(U, { id: "groq", apiKey: "gsk-groq" });
  const onDisk = readConfiguredProviders(U);
  assert.equal(onDisk.length, 2);
  assert.deepEqual(
    onDisk.map((p) => p.id).sort(),
    ["anthropic", "groq"]
  );
});

test("saveProvider maps a custom entry to openai kind and honors baseUrl/models", () => {
  const { config } = saveProvider(U, {
    id: "my-gateway",
    apiStyle: "openai-chat",
    baseUrl: "https://gateway.example.com/v1",
    models: ["model-a", "model-b", "model-c"],
    apiKey: "sk-gw",
  });
  assert.equal(config.kind, "openai");
  assert.equal(config.baseUrl, "https://gateway.example.com/v1");
  assert.deepEqual(config.models, { fast: "model-a", balanced: "model-b", deep: "model-c" });
});

test("saveProvider requires a key for non-local providers", () => {
  assert.throws(() => saveProvider(U, { id: "openai" }), /API key is required/);
});

test("saveProvider allows keyless local providers (ollama)", () => {
  const { config } = saveProvider(U, { id: "ollama" });
  assert.deepEqual(config.keys ?? [], []);
  assert.equal(config.enabled, true);
});

test("normalizeProviderId sanitizes slugs", () => {
  assert.equal(normalizeProviderId("OpenAI"), "openai");
  assert.equal(normalizeProviderId("NVIDIA NIM"), "nvidia-nim");
  assert.equal(normalizeProviderId("  azure-openai "), "azure-openai");
  assert.equal(normalizeProviderId("!!!"), null);
  assert.equal(normalizeProviderId(""), null);
});

test("tierModels maps a model list to tiers", () => {
  assert.deepEqual(tierModels(["a", "b", "c"]), { fast: "a", balanced: "b", deep: "c" });
  assert.deepEqual(tierModels(["a", "b"]), { fast: "a", balanced: "a", deep: "b" });
  assert.deepEqual(tierModels(["a"]), { fast: "a", balanced: "a", deep: "a" });
  assert.deepEqual(tierModels([]), {});
  assert.deepEqual(tierModels(["  ", "a"]), { fast: "a", balanced: "a", deep: "a" });
});

test("routerProviders merges file providers over built-in defaults", () => {
  saveProvider(U, { id: "anthropic", apiKey: "sk-ant-file" });
  saveProvider(U, { id: "sambanova", apiKey: "sn-key" });

  const merged = routerProviders(U);
  const ids = merged.map((p) => p.id);

  // Built-ins still present, but anthropic now comes from the file.
  for (const def of defaultProviderConfigs()) {
    assert.ok(ids.includes(def.id), `missing built-in ${def.id}`);
  }
  const anthropic = merged.find((p) => p.id === "anthropic")!;
  assert.deepEqual(anthropic.keys, ["sk-ant-file"]);
  assert.equal(anthropic.rank, 0, "file override keeps the default rank ordering");

  // New providers are appended after the built-ins.
  assert.ok(ids.includes("sambanova"));
  assert.ok(ids.indexOf("sambanova") > ids.indexOf("openai"));
});

test("routerProviders tolerates a malformed providers file", () => {
  saveProvider(U, { id: "groq", apiKey: "gsk-groq" });
  const file = userProvidersFilePath(U);
  writeFileSync(file, "{ not json");
  const merged = routerProviders(U);
  assert.deepEqual(
    merged.map((p) => p.id),
    defaultProviderConfigs().map((p) => p.id)
  );
  assert.ok(existsSync(file), "malformed file is left in place for inspection");
});

test("savedProviderIds lists the file-backed providers", () => {
  assert.deepEqual(savedProviderIds(U), []);
  saveProvider(U, { id: "openai", apiKey: "sk-openai" });
  saveProvider(U, { id: "groq", apiKey: "gsk-groq" });
  assert.deepEqual(savedProviderIds(U).sort(), ["groq", "openai"]);
});

test("addProviderKey appends a key and reports masked slots only", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-openai-1111" });
  const result = addProviderKey(U, "openai", "sk-openai-2222");
  assert.deepEqual(result.provider.keys, ["sk-openai-1111", "sk-openai-2222"]);
  assert.deepEqual(result.slots, [
    { index: 0, mask: "••••1111" },
    { index: 1, mask: "••••2222" },
  ]);
  const onDisk = readConfiguredProviders(U);
  assert.deepEqual(onDisk[0].keys, ["sk-openai-1111", "sk-openai-2222"]);
});

test("removeProviderKey drops exactly one key by index", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-one-1111" });
  addProviderKey(U, "openai", "sk-two-2222");
  addProviderKey(U, "openai", "sk-three-3333");

  const result = removeProviderKey(U, "openai", 1);
  assert.deepEqual(result.provider.keys, ["sk-one-1111", "sk-three-3333"]);
  assert.equal(result.slots.length, 2);
  assert.deepEqual(readConfiguredProviders(U)[0].keys, ["sk-one-1111", "sk-three-3333"]);
});

test("rotateProviderKey replaces one key in place", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-one-1111" });
  addProviderKey(U, "openai", "sk-two-2222");

  const result = rotateProviderKey(U, "openai", 1, "sk-two-9999");
  assert.deepEqual(result.provider.keys, ["sk-one-1111", "sk-two-9999"]);
  assert.deepEqual(result.slots, [
    { index: 0, mask: "••••1111" },
    { index: 1, mask: "••••9999" },
  ]);
});

test("key mutations reject unknown providers and bad indexes", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-one-1111" });
  assert.throws(() => addProviderKey(U, "nope", "sk-x"), ProviderMutationError);
  assert.throws(() => removeProviderKey(U, "openai", 5), ProviderMutationError);
  assert.throws(() => rotateProviderKey(U, "openai", -1, "sk-x"), ProviderMutationError);
});

test("removeProvider deletes a saved provider and keeps the others", () => {
  saveProvider(U, { id: "openai", apiKey: "sk-openai" });
  saveProvider(U, { id: "groq", apiKey: "gsk-groq" });

  const removed = removeProvider(U, "openai");
  assert.equal(removed.id, "openai");
  const onDisk = readConfiguredProviders(U);
  assert.deepEqual(
    onDisk.map((p) => p.id),
    ["groq"]
  );
  assert.throws(() => removeProvider(U, "openai"), ProviderMutationError);
});

test("resolveDataDir probes each candidate directory only once", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-datadir-"));
  const original = fs.writeFileSync;
  let probes = 0;
  try {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes("write_probe")) probes += 1;
      return (original as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.writeFileSync;

    const first = resolveDataDir({ env: { SWARM_HOME: home } });
    const second = resolveDataDir({ env: { SWARM_HOME: home } });
    assert.equal(first, home);
    assert.equal(second, home);
    assert.equal(probes, 1, `the write probe must run once per directory (ran ${probes} times)`);
  } finally {
    fs.writeFileSync = original;
    rmSync(home, { recursive: true, force: true });
  }
});
