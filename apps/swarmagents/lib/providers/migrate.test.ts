import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyProviders } from "./migrate";
import { configureProviderStorePaths, readConfiguredProviders, saveProvider, userProvidersFilePath } from "./store";
import { configureUserPaths, signupLocalUser } from "../users";

const OWNER = "james@swarmagents.codes";
const OWNER_ID = `local_${OWNER}`;
const OTHER_ID = "local_someone@example.com";

let tempDir: string;
let legacyFile: string;

function writeLegacy(): void {
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      providers: [
        { id: "mercury", kind: "openai", baseUrl: "https://api.inceptionlabs.ai/v1", keys: ["sk-mercury-legacy-1111"], enabled: true },
        { id: "exaone", kind: "openai", baseUrl: "https://api.exaone.ai/v1", keys: ["sk-exaone-legacy-2222"] },
      ],
    })
  );
}

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-provider-migrate-"));
  legacyFile = path.join(tempDir, "providers.json");
  configureProviderStorePaths(legacyFile);
  configureUserPaths(path.join(tempDir, "users.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("moves the legacy file into the owner's account, encrypted, and renames it", async () => {
  await signupLocalUser(OWNER, "a-long-password-1");
  writeLegacy();
  const result = migrateLegacyProviders({ env: {} });
  assert.equal(result.status, "migrated");
  if (result.status !== "migrated") return;
  assert.equal(result.ownerId, OWNER_ID);
  assert.deepEqual(result.providers, ["mercury", "exaone"]);

  assert.equal(fs.existsSync(legacyFile), false, "legacy file no longer at its old path");
  assert.equal(fs.existsSync(`${legacyFile}.migrated`), true);
  assert.equal(fs.statSync(`${legacyFile}.migrated`).mode & 0o777, 0o600);

  const owner = readConfiguredProviders(OWNER_ID);
  assert.deepEqual(owner.map((p) => p.id), ["mercury", "exaone"]);
  assert.deepEqual(owner[0].keys, ["sk-mercury-legacy-1111"]);
  assert.equal(fs.readFileSync(userProvidersFilePath(OWNER_ID), "utf-8").includes("sk-mercury-legacy-1111"), false);

  // No other account gets them, and there is no server-wide fallback left.
  assert.deepEqual(readConfiguredProviders(OTHER_ID), []);
  assert.equal(migrateLegacyProviders({ env: {} }).status, "no-legacy-file", "idempotent");
});

test("SWARM_OWNER_EMAIL picks the owner", async () => {
  await signupLocalUser("boss@example.com", "a-long-password-1");
  writeLegacy();
  const result = migrateLegacyProviders({ env: { SWARM_OWNER_EMAIL: "Boss@Example.com" } });
  assert.equal(result.status, "migrated");
  assert.equal(readConfiguredProviders("local_boss@example.com").length, 2);
  assert.equal(readConfiguredProviders(OWNER_ID).length, 0);
});

test("does nothing until the owner account exists (keys are never parked under an unclaimed id)", () => {
  writeLegacy();
  const result = migrateLegacyProviders({ env: {} });
  assert.equal(result.status, "owner-missing");
  assert.equal(fs.existsSync(legacyFile), true, "legacy file left in place");
  assert.equal(fs.existsSync(userProvidersFilePath(OWNER_ID)), false);
});

test("merges into an owner who already saved providers, keeping their own entries", async () => {
  await signupLocalUser(OWNER, "a-long-password-1");
  saveProvider(OWNER_ID, { id: "mercury", apiKey: "sk-mercury-own-9999" });
  writeLegacy();
  const result = migrateLegacyProviders({ env: {} });
  assert.equal(result.status, "migrated");
  if (result.status !== "migrated") return;
  assert.deepEqual(result.merged, ["mercury"]);
  const owner = readConfiguredProviders(OWNER_ID);
  assert.deepEqual(owner.find((p) => p.id === "mercury")?.keys, ["sk-mercury-own-9999", "sk-mercury-legacy-1111"]);
  assert.deepEqual(owner.find((p) => p.id === "exaone")?.keys, ["sk-exaone-legacy-2222"]);
});

test("an invalid legacy file is reported and left alone", async () => {
  await signupLocalUser(OWNER, "a-long-password-1");
  fs.writeFileSync(legacyFile, "{ nope");
  assert.equal(migrateLegacyProviders({ env: {} }).status, "invalid-file");
  assert.equal(fs.existsSync(legacyFile), true);
});

test("providers.example.json migrates keyless and disabled, exactly as DEPLOY.md says", async () => {
  await signupLocalUser(OWNER, "a-long-password-1");
  const example = fs.readFileSync(new URL("../../providers.example.json", import.meta.url), "utf-8");
  fs.writeFileSync(legacyFile, example);
  const result = migrateLegacyProviders({ env: { ITERACOMPUTE_API_KEY: "sk-env-not-used", EXAONE_API_KEY: "sk-env-not-used" } });
  assert.equal(result.status, "migrated");
  const owner = readConfiguredProviders(OWNER_ID);
  assert.deepEqual(owner.map((p) => p.id), ["iteracompute", "exaone"]);
  for (const entry of owner) {
    // envKeys are dropped and env keys are never copied in: the owner adds
    // the key per account after migration.
    assert.deepEqual(entry.keys, [], `${entry.id} arrives keyless`);
    assert.equal(entry.envKeys, undefined, `${entry.id} carries no envKeys`);
    // Shipped disabled so an unedited copy never routes to a placeholder id.
    assert.equal(entry.enabled, false, `${entry.id} ships disabled`);
  }
});
