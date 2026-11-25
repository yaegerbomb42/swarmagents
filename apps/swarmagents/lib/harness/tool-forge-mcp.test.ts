import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolForgeMcpServerSource } from "./tool-forge-mcp";

test("tool-forge validates input schemas, binds env by name only, and registers/removes MCP servers", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tool-forge-2-"));
  try {
    const serverPath = path.join(tmp, "tool-forge-server.mjs");
    const catalogPath = path.join(tmp, "tool-catalog.json");
    const customDir = path.join(tmp, "custom-tools");
    const mcpPath = path.join(tmp, "mcp.json");
    const atlasPath = path.join(tmp, "atlas.json");

    fs.writeFileSync(serverPath, toolForgeMcpServerSource(), "utf8");
    fs.writeFileSync(catalogPath, "[]", "utf8");
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), "utf8");
    fs.writeFileSync(atlasPath, JSON.stringify({ schema: "swarm.capability-atlas", entries: [] }), "utf8");

    const forgeEnv = {
      ...process.env,
      SWARM_TOOL_CATALOG: catalogPath,
      SWARM_CUSTOM_TOOLS_DIR: customDir,
      SWARM_MCP_CONFIG: mcpPath,
      SWARM_ATLAS_REGISTRY: atlasPath,
      MY_TEST_BOUND: "bound-value",
      NOT_BOUND_SECRET: "should-not-leak",
    };
    const runForge = (messages: unknown[]) => {
      const res = spawnSync("node", [serverPath], {
        input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
        encoding: "utf8",
        env: forgeEnv,
      });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: number; error?: { message?: string }; result?: { content?: Array<{ text: string }> } });
    };
    const call = (id: number, name: string, args: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });

    // Invalid schema (required names an undeclared property) and invalid env
    // names are rejected before any file is written.
    const bad = runForge([
      call(1, "author_tool", {
        id: "bad-schema",
        name: "Bad Schema",
        description: "Has a required prop that is not declared.",
        runtime: "node",
        code: 'console.log("x");',
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["missing"] },
      }),
      call(2, "author_tool", {
        id: "bad-env",
        name: "Bad Env",
        description: "Binds a lowercase env name.",
        runtime: "node",
        code: 'console.log("x");',
        env: ["lowercase_name"],
      }),
      call(3, "register_mcp", {
        id: "bad-url",
        name: "Bad URL",
        description: "HTTP server with credentials in the URL.",
        transport: "http",
        url: "https://user:pass@example.com/mcp",
      }),
      call(4, "register_mcp", {
        id: "bad-args",
        name: "Bad Args",
        description: "stdio server with a shell metacharacter in args.",
        transport: "stdio",
        command: "npx",
        args: ["some-pkg; rm -rf /"],
      }),
    ]);
    assert.match(bad.find((r) => r.id === 1)?.error?.message ?? "", /Invalid inputSchema/);
    assert.match(bad.find((r) => r.id === 2)?.error?.message ?? "", /Invalid env binding/);
    assert.match(bad.find((r) => r.id === 3)?.error?.message ?? "", /no embedded credentials/);
    assert.match(bad.find((r) => r.id === 4)?.error?.message ?? "", /shell metacharacters/);
    assert.ok(!fs.existsSync(path.join(customDir, "bad-schema")));
    assert.ok(!fs.existsSync(path.join(customDir, "bad-env")));

    // Author a schema-validated tool with a bound env name. The script echoes
    // its visible env keys so the test can prove the allowlist works.
    const authored = runForge([
      call(1, "author_tool", {
        id: "env-echo",
        name: "Env Echo",
        description: "Echoes visible env keys and its input.",
        runtime: "node",
        code: 'console.log(JSON.stringify(Object.keys(process.env).sort()));',
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, count: { type: "integer" } },
          required: ["text"],
        },
        env: ["MY_TEST_BOUND"],
      }),
    ]);
    assert.match(authored.find((r) => r.id === 1)?.result?.content?.[0]?.text ?? "", /Input schema validated/);
    assert.match(authored.find((r) => r.id === 1)?.result?.content?.[0]?.text ?? "", /MY_TEST_BOUND/);

    // The generated wrapper enforces the schema and the env allowlist.
    const wrapperPath = path.join(customDir, "env-echo", "mcp-server.mjs");
    const runWrapper = (messages: unknown[]) => {
      const res = spawnSync("node", [wrapperPath], {
        input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", MY_TEST_BOUND: "bound-value", NOT_BOUND_SECRET: "should-not-leak" },
      });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: number; error?: { message?: string }; result?: { content?: Array<{ text: string }>; tools?: Array<{ inputSchema?: unknown }> } });
    };
    const list = runWrapper([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    assert.deepEqual(list.find((r) => r.id === 1)?.result?.tools?.[0]?.inputSchema, {
      type: "object",
      properties: { text: { type: "string" }, count: { type: "integer" } },
      required: ["text"],
    });
    const calls = runWrapper([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "env-echo", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "env-echo", arguments: { text: 5 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "env-echo", arguments: { text: "hi", count: 2 } } },
    ]);
    assert.match(calls.find((r) => r.id === 2)?.error?.message ?? "", /Missing required argument "text"/);
    assert.match(calls.find((r) => r.id === 3)?.error?.message ?? "", /must be a string/);
    const envKeys = calls.find((r) => r.id === 4)?.result?.content?.[0]?.text ?? "";
    assert.ok(envKeys.includes("MY_TEST_BOUND"), "bound name visible: " + envKeys);
    assert.ok(envKeys.includes("SWARM_TOOL_INPUT"), "base env visible: " + envKeys);
    assert.ok(!envKeys.includes("NOT_BOUND_SECRET"), "unbound secret must not leak: " + envKeys);

    // Register an stdio MCP and an HTTP MCP, manage them, then remove both.
    const registered = runForge([
      call(1, "register_mcp", {
        id: "exa",
        name: "Exa",
        description: "Neural web search server.",
        transport: "stdio",
        command: "npx",
        args: ["exa-mcp-server"],
      }),
      call(2, "register_mcp", {
        id: "remote-docs",
        name: "Remote Docs",
        description: "Remote docs server.",
        transport: "http",
        url: "https://docs.example.com/mcp",
      }),
      call(3, "register_mcp", {
        id: "env-echo",
        name: "Collision",
        description: "Collides with the authored tool id.",
        transport: "stdio",
        command: "npx",
        args: ["other-pkg"],
      }),
      call(4, "list_my_tools", {}),
    ]);
    assert.match(registered.find((r) => r.id === 1)?.result?.content?.[0]?.text ?? "", /registered as 'custom-exa'/);
    assert.match(registered.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? "", /registered as 'custom-remote-docs'/);
    assert.match(registered.find((r) => r.id === 3)?.error?.message ?? "", /already an authored tool/);
    assert.match(registered.find((r) => r.id === 4)?.result?.content?.[0]?.text ?? "", /exa\[on:stdio\]/);
    assert.match(registered.find((r) => r.id === 4)?.result?.content?.[0]?.text ?? "", /remote-docs\[on:http\]/);

    let mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(mcp.mcpServers["custom-exa"], { type: "stdio", command: "npx", args: ["exa-mcp-server"] });
    assert.deepEqual(mcp.mcpServers["custom-remote-docs"], { type: "http", url: "https://docs.example.com/mcp" });

    const managed = runForge([
      call(1, "manage_mcp", { action: "disable", id: "exa" }),
      call(2, "manage_mcp", { action: "unregister", id: "remote-docs" }),
      call(3, "manage_mcp", { action: "remove", id: "env-echo" }),
      call(4, "manage_mcp", { action: "unregister", id: "env-echo" }),
    ]);
    assert.match(managed.find((r) => r.id === 1)?.result?.content?.[0]?.text ?? "", /disabled/);
    assert.match(managed.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? "", /unregistered/);
    assert.match(managed.find((r) => r.id === 3)?.result?.content?.[0]?.text ?? "", /removed/);
    assert.match(managed.find((r) => r.id === 4)?.error?.message ?? "", /not found/);

    mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(!("custom-exa" in mcp.mcpServers), "disabled server leaves mcp.json");
    assert.ok(!("custom-remote-docs" in mcp.mcpServers), "unregistered server leaves mcp.json");
    assert.ok(!("custom-env-echo" in mcp.mcpServers), "removed tool leaves mcp.json");
    assert.ok(!fs.existsSync(path.join(customDir, "env-echo")), "removed tool directory is deleted");
    const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8")) as { entries: Array<{ id: string }> };
    assert.ok(!atlas.entries.some((e) => e.id === "custom:env-echo"), "removed tool leaves the atlas");
    assert.ok(!atlas.entries.some((e) => e.id === "custom-mcp:remote-docs"), "unregistered server leaves the atlas");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tool-forge MCP server searches catalog, authors + smoke-tests a custom tool, and manages it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tool-forge-"));
  try {
    const serverPath = path.join(tmp, "tool-forge-server.mjs");
    const catalogPath = path.join(tmp, "tool-catalog.json");
    const customDir = path.join(tmp, "custom-tools");
    const mcpPath = path.join(tmp, "mcp.json");
    const atlasPath = path.join(tmp, "atlas.json");

    fs.writeFileSync(serverPath, toolForgeMcpServerSource(), "utf8");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify([
        { id: "slack", name: "Slack", category: "apps-productivity", oneClick: false, summary: "Post messages and read channels." },
        { id: "exa", name: "Exa", category: "search-data", oneClick: true, summary: "Neural web search." },
      ]),
      "utf8",
    );
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), "utf8");
    fs.writeFileSync(atlasPath, JSON.stringify({ schema: "swarm.capability-atlas", entries: [] }), "utf8");

    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_mcp_catalog", arguments: { query: "slack" } } },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "author_tool",
          arguments: {
            id: "echo-upper",
            name: "Echo Upper",
            description: "Uppercases its input string.",
            runtime: "node",
            code: 'console.log((process.env.SWARM_TOOL_INPUT || "").toUpperCase());',
            testArgs: "hello",
          },
        },
      },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "manage_mcp", arguments: { action: "disable", id: "echo-upper" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_my_tools", arguments: {} } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "install_online_skill", arguments: { id: "../etc/passwd" } } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n";

    const res = spawnSync("node", [serverPath], {
      input: messages,
      encoding: "utf8",
      env: {
        ...process.env,
        SWARM_TOOL_CATALOG: catalogPath,
        SWARM_CUSTOM_TOOLS_DIR: customDir,
        SWARM_MCP_CONFIG: mcpPath,
        SWARM_ATLAS_REGISTRY: atlasPath,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const replies = res.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; error?: { message?: string }; result?: { content?: Array<{ text: string }>; tools?: unknown[] } });

    assert.equal(replies.find((r) => r.id === 2)?.result?.tools?.length, 8);
    assert.match(replies.find((r) => r.id === 3)?.result?.content?.[0]?.text ?? "", /slack \|/);
    assert.match(replies.find((r) => r.id === 4)?.result?.content?.[0]?.text ?? "", /HELLO/);
    assert.match(replies.find((r) => r.id === 5)?.result?.content?.[0]?.text ?? "", /disabled/);
    assert.match(replies.find((r) => r.id === 6)?.result?.content?.[0]?.text ?? "", /echo-upper\[off\]/);
    assert.match(replies.find((r) => r.id === 7)?.error?.message ?? "", /Invalid skill id/);

    const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8")) as { entries: Array<{ id: string }> };
    assert.ok(atlas.entries.some((e) => e.id === "custom:echo-upper"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
