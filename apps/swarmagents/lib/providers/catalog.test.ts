import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG, catalogEntry, providerKindForCatalog, providerHue } from "./catalog";
import type {
  CatalogApiStyle,
  CatalogAuthHeader,
  ProviderCatalogEntry,
} from "./catalog";

const API_STYLES: readonly CatalogApiStyle[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "ollama",
];

const AUTH_HEADERS: readonly CatalogAuthHeader[] = [
  "bearer",
  "x-api-key",
  "x-goog-api-key",
  "none",
  "custom",
];

const REQUIRED_LINK_KEYS = ["signup", "console", "apiKeys", "docs", "pricing"] as const;

test("catalog has 25+ entries, each with a unique stable id", () => {
  assert.ok(
    PROVIDER_CATALOG.length >= 25,
    `expected at least 25 providers, got ${PROVIDER_CATALOG.length}`
  );
  const ids = PROVIDER_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "provider ids must be unique");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `id "${id}" must be a lowercase slug`);
  }
});

test("every entry has the required shape", () => {
  for (const entry of PROVIDER_CATALOG) {
    assert.equal(typeof entry.id, "string", `${entry.id}: id must be a string`);
    assert.ok(entry.id.length > 0, `${entry.id}: id must be non-empty`);
    assert.equal(typeof entry.name, "string", `${entry.id}: name must be a string`);
    assert.ok(entry.name.trim().length > 0, `${entry.id}: name must be non-empty`);
    assert.equal(typeof entry.shortDescription, "string", `${entry.id}: shortDescription must be a string`);
    assert.ok(entry.shortDescription.trim().length > 0, `${entry.id}: shortDescription must be non-empty`);

    assert.ok(
      API_STYLES.includes(entry.apiStyle),
      `${entry.id}: apiStyle "${entry.apiStyle}" must be one of ${API_STYLES.join(", ")}`
    );
    assert.ok(
      AUTH_HEADERS.includes(entry.authHeader),
      `${entry.id}: authHeader "${entry.authHeader}" must be one of ${AUTH_HEADERS.join(", ")}`
    );

    assert.equal(typeof entry.envVar, "string", `${entry.id}: envVar must be a string`);
    assert.match(
      entry.envVar,
      /^SWARM_KEYS_[A-Z0-9_]+$/,
      `${entry.id}: envVar "${entry.envVar}" must match SWARM_KEYS_<PROVIDER>`
    );

    if (entry.isLocal) {
      assert.ok(entry.links, `${entry.id}: local providers must have a links object`);
    }

    if (entry.models) {
      if (entry.models.default !== undefined) {
        assert.equal(typeof entry.models.default, "string", `${entry.id}: models.default must be a string`);
      }
      assert.ok(Array.isArray(entry.models.popular), `${entry.id}: models.popular must be an array`);
      for (const model of entry.models.popular) {
        assert.equal(typeof model, "string", `${entry.id}: popular model must be a string`);
        assert.ok(model.trim().length > 0, `${entry.id}: popular model must be non-empty`);
      }
    }
  }
});

test("every provided link is a real-looking https URL", () => {
  for (const entry of PROVIDER_CATALOG) {
    if (!entry.links) continue;
    for (const key of REQUIRED_LINK_KEYS) {
      const value = entry.links[key];
      if (value === undefined) continue;
      assert.equal(typeof value, "string", `${entry.id}: links.${key} must be a string`);
      assert.match(
        value,
        /^https:\/\/[^\s]+$/,
        `${entry.id}: links.${key} must be an https URL, got "${value}"`
      );
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        assert.fail(`${entry.id}: links.${key} is not a valid URL: "${value}"`);
      }
      assert.equal(url.protocol, "https:", `${entry.id}: links.${key} must use https`);
      assert.ok(url.hostname.includes("."), `${entry.id}: links.${key} must be an absolute host URL`);
    }
  }
});

test("every baseUrl is http(s) and local providers use loopback", () => {
  for (const entry of PROVIDER_CATALOG) {
    if (!entry.baseUrl) continue;
    let url: URL;
    try {
      url = new URL(entry.baseUrl);
    } catch {
      assert.fail(`${entry.id}: baseUrl is not a valid URL: "${entry.baseUrl}"`);
    }
    assert.ok(
      url.protocol === "https:" || url.protocol === "http:",
      `${entry.id}: baseUrl must be http(s)`
    );
    if (entry.isLocal) {
      assert.equal(url.protocol, "http:", `${entry.id}: local baseUrl should be http`);
      assert.ok(
        url.hostname === "localhost" || url.hostname === "127.0.0.1",
        `${entry.id}: local baseUrl should use localhost`
      );
    } else {
      assert.equal(url.protocol, "https:", `${entry.id}: non-local baseUrl must be https`);
      assert.ok(url.hostname.includes("."), `${entry.id}: baseUrl must be an absolute host`);
    }
  }
});

test("providerKindForCatalog maps styles to the server kinds", () => {
  assert.equal(providerKindForCatalog({ apiStyle: "anthropic" } as ProviderCatalogEntry), "anthropic");
  assert.equal(providerKindForCatalog({ apiStyle: "gemini" } as ProviderCatalogEntry), "gemini");
  assert.equal(providerKindForCatalog({ apiStyle: "openai-compatible" } as ProviderCatalogEntry), "openai");
  assert.equal(providerKindForCatalog({ apiStyle: "custom" } as ProviderCatalogEntry), "openai");
});

test("catalogEntry finds by id and providerHue is stable", () => {
  const openai = catalogEntry("openai");
  assert.ok(openai);
  assert.equal(openai?.name, "OpenAI");
  assert.equal(catalogEntry("does-not-exist"), undefined);
  assert.equal(providerHue("openai"), providerHue("openai"));
  assert.ok(providerHue("openai") >= 0 && providerHue("openai") < 360);
});

test("the required provider set is present", () => {
  const ids = new Set(PROVIDER_CATALOG.map((entry) => entry.id));
  const required = [
    "openai",
    "anthropic",
    "gemini",
    "mistral",
    "groq",
    "cerebras",
    "deepseek",
    "xai",
    "openrouter",
    "together",
    "fireworks",
    "perplexity",
    "cohere",
    "nvidia-nim",
    "inception",
    "radium",
    "sambanova",
    "huggingface",
    "ollama",
    "lmstudio",
    "azure-openai",
    "aws-bedrock",
    "zai",
    "qwen",
    "moonshot",
    "minimax",
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing required provider "${id}"`);
  }
});

test("NVIDIA NIM default is the live lightning model, not the retired 340b id", () => {
  const nvidia = catalogEntry("nvidia-nim");
  assert.ok(nvidia, "nvidia-nim catalog entry");
  assert.equal(nvidia.models?.default, "nvidia/nemotron-3.5-lightning-30b-a3b");
  assert.equal(nvidia.models?.popular?.[0], "nvidia/nemotron-3.5-lightning-30b-a3b");
  const listed = [nvidia.models?.default, ...(nvidia.models?.popular ?? [])];
  assert.equal(listed.includes("nvidia/nemotron-4-340b-instruct"), false);
});

test("canonicalProviderId normalizes mixed case and invalid chars into slugs", () => {
  const { canonicalProviderId } = require("./catalog");
  assert.equal(canonicalProviderId("OpenAI"), "openai");
  assert.equal(canonicalProviderId("  OpenAI  "), "openai");
  assert.equal(canonicalProviderId("NVIDIA NIM"), "nvidia-nim");
  assert.equal(canonicalProviderId("azure-openai"), "azure-openai");
  assert.equal(canonicalProviderId("---my--provider---"), "my--provider");
  assert.equal(canonicalProviderId(""), "");
  assert.equal(canonicalProviderId(null), "");
  assert.equal(canonicalProviderId(undefined), "");
  assert.equal(canonicalProviderId(123), "");
});
