import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CATALOG, catalogEntry, providerKindForCatalog } from "./catalog";
import { MORE_HOSTED_PROVIDERS, MORE_LOCAL_PROVIDERS, MORE_PROVIDER_CATALOG } from "./catalog-more";
import { ProviderMutationError, configureProviderStorePaths, saveProvider } from "./store";
import { userPoolProviders } from "./user-run-pool";

test("every ported provider is registered in PROVIDER_CATALOG exactly once", () => {
  assert.ok(MORE_PROVIDER_CATALOG.length >= 50, `ported ${MORE_PROVIDER_CATALOG.length}`);
  const ids = PROVIDER_CATALOG.map((e) => e.id);
  for (const entry of MORE_PROVIDER_CATALOG) {
    assert.equal(ids.filter((id) => id === entry.id).length, 1, entry.id);
    assert.equal(catalogEntry(entry.id), entry);
  }
});

test("custom stays the last catalog entry (the providers page opens it as the catch-all)", () => {
  assert.equal(PROVIDER_CATALOG[PROVIDER_CATALOG.length - 1].id, "custom");
});

test("no duplicate of a provider the main catalog already has under another id", () => {
  for (const id of ["nvidia", "azure", "bedrock"]) assert.equal(catalogEntry(id), undefined, id);
  for (const id of ["nvidia-nim", "azure-openai", "aws-bedrock"]) assert.ok(catalogEntry(id), id);
});

test("hosted entries: https, a key, an official key page; account-specific roots carry no fake URL", () => {
  for (const entry of MORE_HOSTED_PROVIDERS) {
    assert.notEqual(entry.isLocal, true, entry.id);
    assert.equal(providerKindForCatalog(entry), "openai", `${entry.id} goes through the OpenAI translation proxy`);
    assert.notEqual(entry.authHeader, "none", `${entry.id} needs a key`);
    assert.ok(entry.links.apiKeys, `${entry.id} links to where the key comes from`);
    assert.match(entry.envVar, new RegExp(`^SWARM_KEYS_${entry.id.toUpperCase().replace(/-/g, "_")}$`));
    if (entry.baseUrl) {
      assert.doesNotMatch(entry.baseUrl, /[{}<>]/, `${entry.id}: no template placeholders in baseUrl`);
    } else {
      assert.match(entry.authHint ?? "", /^Base URL: https:\/\/\S+/, `${entry.id}: tells the user the URL shape`);
    }
  }
});

test("local entries: keyless loopback servers", () => {
  assert.ok(MORE_LOCAL_PROVIDERS.length >= 10);
  for (const entry of MORE_LOCAL_PROVIDERS) {
    assert.equal(entry.isLocal, true, entry.id);
    assert.equal(entry.authHeader, "none", entry.id);
    assert.ok(entry.baseUrl?.startsWith("http://localhost:"), entry.id);
    assert.ok(entry.links.docs, `${entry.id} links to its docs`);
  }
});

test("a user can add a ported provider: hosted needs their key, local needs none", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-catalog-more-"));
  configureProviderStorePaths(join(dir, "providers.json"));
  try {
    const user = "catalog_more@example.com";
    assert.throws(() => saveProvider(user, { id: "siliconflow" }), ProviderMutationError);
    const hosted = saveProvider(user, { id: "siliconflow", apiKey: "sk-test-siliconflow-0000" }).config;
    assert.equal(hosted.baseUrl, "https://api.siliconflow.com/v1");
    assert.equal(hosted.kind, "openai");
    const local = saveProvider(user, { id: "vllm" }).config;
    assert.equal(local.baseUrl, "http://localhost:8000/v1");
    const azure = saveProvider(user, {
      id: "azure-foundry",
      apiKey: "azure-test-0000",
      baseUrl: "https://my-res.services.ai.azure.com/openai/v1",
    }).config;
    assert.deepEqual(azure.auth, { scheme: "custom-header", headerName: "api-key" });
    const pool = userPoolProviders(user);
    assert.deepEqual(pool.find((p) => p.id === "siliconflow")?.keys, ["sk-test-siliconflow-0000"]);
  } finally {
    configureProviderStorePaths("");
    rmSync(dir, { recursive: true, force: true });
  }
});
