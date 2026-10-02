// Per-account storage for connections (tool keys, LLM providers, MCP servers, sub-agent settings) in server mode.
// Run: npx tsx tests/tenant-connections.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tenant-test-"));
process.env.SWARM_HOME = home;
process.env.SWARM_MODE = "server";
process.env.TENANT_TEST_ENV_SECRET = "operator-secret-123456";
process.env.GITHUB_TOKEN = "operator-github-token-0000";

const store = await import("../lib/store.ts");
const conn = await import("../lib/connections.ts");
const sub = await import("../lib/subagent-settings.ts");
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
let mcpId = "";
let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok", name);
};

try {
  t("no tenant context on a server throws instead of using shared storage", () => {
    assert.throws(() => conn.listConnections(), /No signed-in user/);
  });
  store.runAs(A, () => {
    conn.upsertConnection({ type: "tool", preset: "custom-key", envVar: "A_ONLY_KEY", apiKey: "a-secret-key-111111" });
    mcpId = conn.upsertConnection({ type: "mcp", preset: "custom-stdio", label: "A MCP", command: "node", args: ["x.js"], env: { REF: "${TENANT_TEST_ENV_SECRET}", OWN: "${A_ONLY_KEY}" } }).id;
    sub.saveSubagentSettings({ mode: "fixed", maxParallel: 3 });
  });
  t("account A sees its own key, connector and settings", () =>
    store.runAs(A, () => {
      const list = conn.listConnections();
      assert.ok(list.some((c) => c.type === "tool" && c.envVar === "A_ONLY_KEY"));
      assert.ok(list.some((c) => c.type === "mcp" && c.id === mcpId));
      assert.equal(conn.toolEnv().A_ONLY_KEY, "a-secret-key-111111");
      assert.equal(sub.getSubagentSettings().maxParallel, 3);
    }));
  t("account B sees none of A's data", () =>
    store.runAs(B, () => {
      const list = conn.listConnections();
      assert.ok(!list.some((c) => c.envVar === "A_ONLY_KEY" || c.id === mcpId), JSON.stringify(list));
      assert.deepEqual(conn.toolEnv(), {});
      assert.equal(conn.mcpServerDef(mcpId), undefined);
      assert.equal(sub.getSubagentSettings().mode, "auto");
    }));
  t("K2: no key reaches the terminal unless that key is opted in; per account; masked", () =>
    store.runAs(A, () => {
      assert.deepEqual(conn.terminalEnv(), {}, "off by default");
      const id = conn.listConnections().find((c) => c.envVar === "A_ONLY_KEY").id;
      const other = conn.upsertConnection({ type: "tool", preset: "custom-key", envVar: "A_OTHER_KEY", apiKey: "a-other-key-222222" }).id;
      conn.upsertConnection({ type: "tool", id, terminal: true });
      assert.deepEqual(conn.terminalEnv(), { A_ONLY_KEY: "a-secret-key-111111" }, "only the opted-in key");
      assert.equal(conn.listConnections().find((c) => c.id === id).terminal, true);
      assert.ok(!JSON.stringify(conn.listConnections()).includes("a-secret-key-111111"), "the list never carries the value");
      assert.equal(conn.redactSavedKeys("k=a-secret-key-111111"), "k=••••1111");
      conn.upsertConnection({ type: "tool", id, label: "renamed" });
      assert.equal(conn.terminalEnv().A_ONLY_KEY, "a-secret-key-111111", "an unrelated edit keeps the choice");
      conn.setEnabled("tool", id, false);
      assert.deepEqual(conn.terminalEnv(), {}, "a disabled key is never exported");
      conn.setEnabled("tool", id, true);
      store.runAs(B, () => assert.deepEqual(conn.terminalEnv(), {}, "B never gets A's opt-ins"));
      conn.upsertConnection({ type: "tool", id, terminal: "yes" });
      assert.deepEqual(conn.terminalEnv(), {}, "only an explicit true opts in");
      conn.deleteConnection("tool", other);
    }));
  t("files live under each account's own home", () => {
    assert.ok(fs.existsSync(path.join(home, "users", A, "connections.json")));
    assert.ok(fs.existsSync(path.join(home, "users", A, "mcp.json")));
    assert.ok(fs.existsSync(path.join(home, "users", A, "settings.json")));
    assert.ok(!fs.existsSync(path.join(home, "connections.json")) && !fs.existsSync(path.join(home, "mcp.json")));
    assert.equal(fs.statSync(path.join(home, "users", A, "connections.json")).mode & 0o777, 0o600);
  });
  t("server accounts never borrow the operator's environment", () =>
    store.runAs(A, () => {
      assert.equal(conn.getToolKey("github-token"), undefined);
      const env = conn.mcpEnv({ REF: "${TENANT_TEST_ENV_SECRET}", OWN: "${A_ONLY_KEY}", GH: "${GITHUB_TOKEN:-none}" });
      assert.equal(env.REF, "");
      assert.equal(env.OWN, "a-secret-key-111111");
      assert.equal(env.GH, "none");
    }));
  t("Claude Code / Desktop servers on the machine are not imported for server accounts", () =>
    store.runAs(B, () => {
      assert.ok(!conn.listConnections().some((c) => c.type === "mcp" && c.source && c.source !== "swarm"));
    }));
  console.log(`tenant-connections: ${pass}/${pass} pass`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
