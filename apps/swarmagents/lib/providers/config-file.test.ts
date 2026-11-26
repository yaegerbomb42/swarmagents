import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProvidersFile,
  loadProvidersFromEnv,
  ConfigValidationError,
} from "./config-file";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-providers-"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(name: string, data: unknown): string {
  const path = join(tempDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

test("loadProvidersFile: loads a valid providers file", () => {
  const path = writeJson("providers.json", {
    providers: [
      {
        id: "anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        models: { fast: "claude-haiku", standard: "claude-sonnet", deep: "claude-opus" },
        envKeys: "SWARM_KEYS_ANTHROPIC",
        dailyBudgetUsd: 100,
        inputPricePer1mTokens: 3,
        outputPricePer1mTokens: 15,
        rank: 0,
        enabled: true,
      },
      {
        id: "openai",
        kind: "openai",
        models: { fast: "gpt-4-mini", balanced: "gpt-4", deep: "o3" },
        dailyBudgetUsd: 50,
        rank: 1,
      },
    ],
  });

  const configs = loadProvidersFile(path);
  assert.equal(configs.length, 2);

  const anthropic = configs[0];
  assert.equal(anthropic.id, "anthropic");
  assert.equal(anthropic.kind, "anthropic");
  assert.equal(anthropic.baseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.models?.fast, "claude-haiku");
  assert.equal(anthropic.models?.balanced, "claude-sonnet");
  assert.equal(anthropic.models?.deep, "claude-opus");
  assert.equal(anthropic.envKeys, "SWARM_KEYS_ANTHROPIC");
  assert.equal(anthropic.dailyBudgetUsd, 100);
  assert.equal(anthropic.inputPricePer1mTokens, 3);
  assert.equal(anthropic.outputPricePer1mTokens, 15);
  assert.equal(anthropic.rank, 0);
  assert.equal(anthropic.enabled, true);

  const openai = configs[1];
  assert.equal(openai.id, "openai");
  assert.equal(openai.dailyBudgetUsd, 50);
  assert.equal(openai.rank, 1);
});

test("loadProvidersFile: normalises 'standard' tier to 'balanced'", () => {
  const path = writeJson("providers.json", {
    providers: [
      {
        id: "anthropic",
        kind: "anthropic",
        models: { standard: "claude-sonnet" },
      },
    ],
  });

  const configs = loadProvidersFile(path);
  assert.equal(configs[0].models?.balanced, "claude-sonnet");
  assert.equal(configs[0].models && "standard" in configs[0].models, false);
});

test("loadProvidersFile: throws ConfigValidationError for missing providers array", () => {
  const path = writeJson("bad.json", { providers: "nope" });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
  try {
    loadProvidersFile(path);
  } catch (err) {
    assert.ok(err instanceof ConfigValidationError);
    assert.match((err as ConfigValidationError).message, /providers must be an array/);
  }
});

test("loadProvidersFile: throws for missing id", () => {
  const path = writeJson("bad.json", { providers: [{ kind: "anthropic" }] });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
});

test("loadProvidersFile: throws for invalid kind", () => {
  const path = writeJson("bad.json", { providers: [{ id: "x", kind: "unknown" }] });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
  try {
    loadProvidersFile(path);
  } catch (err) {
    assert.ok(err instanceof ConfigValidationError);
    assert.match((err as ConfigValidationError).message, /must be one of/);
  }
});

test("loadProvidersFile: throws for invalid tier name", () => {
  const path = writeJson("bad.json", {
    providers: [{ id: "x", kind: "anthropic", models: { cheap: "model" } }],
  });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
  try {
    loadProvidersFile(path);
  } catch (err) {
    assert.match((err as ConfigValidationError).message, /invalid tier/);
  }
});

test("loadProvidersFile: throws for bad budget type", () => {
  const path = writeJson("bad.json", {
    providers: [{ id: "x", kind: "anthropic", dailyBudgetUsd: "100" }],
  });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
});

test("loadProvidersFile: throws for negative budget", () => {
  const path = writeJson("bad.json", {
    providers: [{ id: "x", kind: "anthropic", dailyBudgetUsd: -1 }],
  });
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
});

test("loadProvidersFile: throws for invalid JSON", () => {
  const path = join(tempDir, "bad.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => loadProvidersFile(path), ConfigValidationError);
});

test("loadProvidersFile: throws when file is missing", () => {
  assert.throws(() => loadProvidersFile(join(tempDir, "missing.json")));
});

test("loadProvidersFromEnv: returns null when SWARM_PROVIDERS_FILE is unset", () => {
  assert.equal(loadProvidersFromEnv({}), null);
});

test("loadProvidersFromEnv: loads from env var", () => {
  const path = writeJson("providers.json", {
    providers: [{ id: "openai", kind: "openai" }],
  });
  const configs = loadProvidersFromEnv({ SWARM_PROVIDERS_FILE: path });
  assert.ok(configs);
  assert.equal(configs!.length, 1);
  assert.equal(configs![0].id, "openai");
});

test("providers.example.json validates with redacted placeholder keys", () => {
  const examplePath = fileURLToPath(new URL("../../providers.example.json", import.meta.url));
  const raw = readFileSync(examplePath, "utf-8");
  assert.equal(raw.includes("sk-"), false, "example must not ship key material");

  const configs = loadProvidersFile(examplePath);
  const byId = new Map(configs.map((config) => [config.id, config]));

  const iteracompute = byId.get("iteracompute");
  assert.ok(iteracompute, "iteracompute entry");
  assert.equal(iteracompute.kind, "openai");
  assert.equal(iteracompute.apiStyle, "openai-chat");
  assert.equal(iteracompute.baseUrl, "https://api.iteracompute.com/v1");
  assert.equal(iteracompute.envKeys, "ITERACOMPUTE_API_KEY");
  assert.ok(iteracompute.models?.fast, "suggested fast tier placeholder");
  assert.ok(iteracompute.models?.balanced, "suggested balanced tier placeholder");

  const exaone = byId.get("exaone");
  assert.ok(exaone, "exaone entry");
  assert.equal(exaone.kind, "openai");
  assert.equal(exaone.apiStyle, "openai-chat");
  assert.equal(exaone.baseUrl, "https://api.exaone.ai/v1");
  assert.equal(exaone.envKeys, "EXAONE_API_KEY");
  assert.equal(exaone.models?.balanced, "k-exaone_v2.5");
  for (const config of [iteracompute, exaone]) {
    assert.equal(config.keys, undefined, `${config.id} must not carry inline keys`);
  }
});

test("schema validation still rejects example entries missing required fields", () => {
  const examplePath = fileURLToPath(new URL("../../providers.example.json", import.meta.url));
  const example = JSON.parse(readFileSync(examplePath, "utf-8")) as { providers: unknown[] };

  for (const missing of ["id", "kind"] as const) {
    const broken = {
      providers: example.providers.map((entry) => {
        const clone = { ...(entry as Record<string, unknown>) };
        delete clone[missing];
        return clone;
      }),
    };
    assert.throws(
      () => loadProvidersFile(writeJson("broken-providers.json", broken)),
      (err: unknown) => err instanceof ConfigValidationError && err.message.includes(missing),
      `dropping ${missing} must fail validation`,
    );
  }
});
