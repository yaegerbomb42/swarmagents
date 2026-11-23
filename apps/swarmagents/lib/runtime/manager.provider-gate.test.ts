/**
 * Zero-provider run-start guard (FIX-43 follow-up): in server mode an
 * account with no usable saved provider cannot start runs — host env
 * keys are stripped from the router and scrubbed from the fallback env
 * (per-user BYOK), so such a run could only fail in the VM. Refusing at
 * admission names the fix instead. Configured accounts (keyed or
 * keyless-local) and local mode are unaffected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { RunStateStore } from "./durable-queue";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { configureProviderStorePaths, saveProvider } from "../providers/store";
import {
  configureUserPaths,
  signupLocalUser,
  issueEmailVerificationToken,
  consumeEmailVerificationToken,
} from "../users";

function makeManager(dir: string): RuntimeManager {
  const runsDir = path.join(dir, "runs");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  return new RuntimeManager({
    vm: new VmManager({ customDriver: new FakeVmDriver() }),
    bus,
    router: null,
    stateStore: new RunStateStore({ filePath: path.join(dir, "state.json") }),
  });
}

/** Create a local account (base email) and prove email ownership (FIX-44 gate). */
async function verifyLocalUser(baseEmail: string): Promise<void> {
  await signupLocalUser(baseEmail, "correct horse battery");
  const token = await issueEmailVerificationToken(baseEmail);
  assert.equal(await consumeEmailVerificationToken(token), baseEmail);
}

test("server mode: zero-provider account is refused at start(); configured accounts pass", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-provider-gate-"));
  configureProviderStorePaths(path.join(dir, "providers.json"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-provider-gate";
  process.env.SWARM_SERVER_MODE = "1";
  const manager = makeManager(dir);
  try {
    const fresh = "local_fresh@example.test";
    await verifyLocalUser("fresh@example.test");
    const refused = manager.start(fresh, { prompt: "do a thing" });
    assert.equal(refused.accepted, false);
    assert.match(refused.error ?? "", /No model provider is configured/);
    assert.match(refused.error ?? "", /Settings/);
    assert.equal(manager.list(fresh).length, 0, "refused run is not queued");

    // The refusal is a constant string: it must not leak another
    // account's provider details (ids, key material) to the caller.
    saveProvider("local_other@example.test", {
      id: "deepseek",
      apiKey: "sk-other-account-secret",
    });
    const refusedAgain = manager.start(fresh, { prompt: "do a thing" });
    assert.equal(refusedAgain.accepted, false);
    assert.equal(refusedAgain.error, refused.error);
    assert.doesNotMatch(refusedAgain.error ?? "", /deepseek|sk-other-account-secret/);

    // A keyed provider makes the same account admissible.
    saveProvider(fresh, { id: "deepseek", apiKey: "sk-test-key" });
    const accepted = manager.start(fresh, { prompt: "do a thing" });
    assert.equal(accepted.accepted, true);

    // A keyless local provider (Ollama) is a usable provider too.
    const ollamaUser = "local_ollama@example.test";
    await verifyLocalUser("ollama@example.test");
    saveProvider(ollamaUser, { id: "ollama" });
    assert.equal(manager.start(ollamaUser, { prompt: "do a thing" }).accepted, true);

    // A disabled-only provider is not usable and stays refused.
    const disabledUser = "local_disabled@example.test";
    await verifyLocalUser("disabled@example.test");
    saveProvider(disabledUser, { id: "deepseek", apiKey: "sk-test-key", enabled: false });
    const disabledRefused = manager.start(disabledUser, { prompt: "do a thing" });
    assert.equal(disabledRefused.accepted, false);
    assert.match(disabledRefused.error ?? "", /No model provider is configured/);
  } finally {
    await manager.cancelAll("shutdown");
    configureUserPaths("");
    configureProviderStorePaths("");
    delete process.env.SWARM_SESSION_SECRET;
    delete process.env.SWARM_SERVER_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local mode: zero-provider account is not gated (host env serves the single user)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-provider-gate-local-"));
  configureProviderStorePaths(path.join(dir, "providers.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-provider-gate";
  delete process.env.SWARM_SERVER_MODE;
  const manager = makeManager(dir);
  try {
    const started = manager.start("local_fresh@example.test", { prompt: "do a thing" });
    assert.equal(started.accepted, true);
  } finally {
    await manager.cancelAll("shutdown");
    configureProviderStorePaths("");
    delete process.env.SWARM_SESSION_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
