/**
 * FIX-44 run-start gate: in server mode an unverified local account
 * cannot start runs (accounts consume VM compute; open sign-ups must
 * prove email ownership first). Verified accounts, non-local
 * identities, and local mode are unaffected.
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
import {
  configureUserPaths,
  consumeEmailVerificationToken,
  issueEmailVerificationToken,
  signupLocalUser,
} from "../users";
import { configureProviderStorePaths, saveProvider } from "../providers/store";

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

test("server mode: unverified local account is refused at start(); verified and non-local pass", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-verify-gate-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
  process.env.SWARM_SERVER_MODE = "1";
  const manager = makeManager(dir);
  try {
    // Zero-provider guard (FIX-43 follow-up): server-mode runs need a saved
    // provider. Seed one for every account the test expects to pass.
    configureProviderStorePaths(path.join(dir, "providers.json"));
    saveProvider("alice", { id: "deepseek", apiKey: "sk-test" });
    saveProvider("local_gate@example.com", { id: "deepseek", apiKey: "sk-test" });
    await signupLocalUser("gate@example.com", "correct horse battery");
    const refused = manager.start("local_gate@example.com", { prompt: "do a thing" });
    assert.equal(refused.accepted, false);
    assert.match(refused.error ?? "", /Verify your email/);
    assert.equal(manager.list("local_gate@example.com").length, 0, "refused run is not queued");

    // Non-local identities carry no verification flag and are not gated.
    const nonLocal = manager.start("alice", { prompt: "do a thing" });
    assert.equal(nonLocal.accepted, true);

    // After the emailed link is consumed, the same account can start.
    const token = await issueEmailVerificationToken("gate@example.com");
    assert.ok(token);
    assert.equal(await consumeEmailVerificationToken(token), "gate@example.com");
    const accepted = manager.start("local_gate@example.com", { prompt: "do a thing" });
    assert.equal(accepted.accepted, true);
  } finally {
    await manager.cancelAll("shutdown");
    configureUserPaths("");
    configureProviderStorePaths("");
    delete process.env.SWARM_SESSION_SECRET;
    delete process.env.SWARM_SERVER_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local mode: unverified local account is not gated (single trusted user)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-verify-gate-local-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
  delete process.env.SWARM_SERVER_MODE;
  const manager = makeManager(dir);
  try {
    await signupLocalUser("local@example.com", "correct horse battery");
    const started = manager.start("local_local@example.com", { prompt: "do a thing" });
    assert.equal(started.accepted, true);
  } finally {
    await manager.cancelAll("shutdown");
    configureUserPaths("");
    delete process.env.SWARM_SESSION_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
