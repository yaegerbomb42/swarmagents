/**
 * Agent Studio core: manifest validation, secret stripping, the store
 * (round-trip, history, clone, import), compatibility reporting and the
 * SwarmAgents adapter's deploy contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_MANIFEST_VERSION,
  containsSecretKeys,
  isKnownModel,
  stripSecrets,
  validateManifest,
  type AgentCatalog,
  type AgentManifest,
} from "./manifest";
import { catalogModelIds } from "./manifest";
import {
  AGENT_HISTORY_LIMIT,
  cloneAgent,
  configureAgentsDir,
  deleteAgent,
  exportAgent,
  exportContainsSecrets,
  getAgent,
  getAgentHistory,
  importAgent,
  listAgents,
  restoreAgentVersion,
  saveAgent,
} from "./store";
import { compatibilityReport, harnessTools } from "./compatibility";
import { buildDeployPrompt, effectiveToolAllowlist, swarmAdapter } from "./adapters/swarm";
import type { RuntimeManager } from "../runtime/manager";

const MODELS = catalogModelIds();
const PREFERRED = [...MODELS][0];
const FALLBACK = [...MODELS][1];

/** A catalog that knows the models plus one skill, one workflow, one connector. */
function catalog(overrides: Partial<Record<keyof AgentCatalog, string[]>> = {}): AgentCatalog {
  return {
    models: MODELS,
    skills: new Set(overrides.skills ?? ["skill-one"]),
    workflows: new Set(overrides.workflows ?? ["flow-one"]),
    connectors: new Set(overrides.connectors ?? ["github"]),
    mcpServers: new Set(overrides.mcpServers ?? ["library-tools"]),
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: AGENT_MANIFEST_VERSION,
    id: "triage-bot",
    name: "Triage bot",
    description: "Reads issues and routes them.",
    identity: { systemPrompt: "You triage incoming issues and route them to the right queue.", tone: "terse" },
    models: { preferred: PREFERRED, fallbacks: [FALLBACK] },
    tools: ["Read", "Grep", "Bash"],
    mcp: [{ name: "library-tools", transport: "stdio", command: "node server.mjs" }],
    connectors: ["github"],
    context: ["skill-one"],
    memory: { policy: "session" },
    skills: ["skill-one"],
    workflows: ["flow-one"],
    policies: { maxTurns: 20, maxCostUsd: 2 },
    permissions: { allowTools: ["Edit"], denyTools: ["Write"], approvalRequired: true },
    subagents: [{ name: "researcher", instructions: "Find context.", tools: ["Read"] }],
    ...overrides,
  };
}

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-agents-"));
  configureAgentsDir(dir);
});

test.afterEach(() => {
  configureAgentsDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a valid manifest validates and normalizes", () => {
  const result = validateManifest(manifest(), catalog());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.id, "triage-bot");
  assert.equal(result.manifest.models.fallbacks.length, 1);
  assert.equal(result.manifest.tools.includes("Bash"), true);
  assert.deepEqual(result.warnings, []);
});

test("each invalid manifest fails with its own error", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [manifest({ version: 2 }), /version must be 1/],
    [manifest({ id: "Not A Slug" }), /id must be a slug/],
    [manifest({ identity: { systemPrompt: "   " } }), /systemPrompt is required/],
    [manifest({ models: { preferred: "totally-fake-model", fallbacks: [] } }), /not a model in the provider catalog/],
    [manifest({ skills: ["nope"] }), /skill "nope" does not exist/],
    [manifest({ workflows: ["nope"] }), /workflow "nope" does not exist/],
    [manifest({ name: "x".repeat(101) }), /name must be at most/],
    [manifest({ memory: { policy: "forever" } }), /memory.policy must be/],
  ];
  for (const [input, pattern] of cases) {
    const result = validateManifest(input, catalog());
    assert.equal(result.ok, false, `expected failure for ${pattern}`);
    if (result.ok) continue;
    assert.ok(result.errors.some((error) => pattern.test(error)), `expected ${pattern} in ${JSON.stringify(result.errors)}`);
  }
});

test("unknown MCP servers and connectors are warnings, not errors", () => {
  const result = validateManifest(
    manifest({
      mcp: [{ name: "mystery-server", transport: "http", url: "https://example.test/mcp" }],
      connectors: ["jira"],
    }),
    catalog(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.warnings.some((warning) => /mystery-server/.test(warning)));
  assert.ok(result.warnings.some((warning) => /jira/.test(warning)));
});

test("a denied tool that is also allowlisted is a warning", () => {
  const result = validateManifest(
    manifest({ permissions: { allowTools: ["Write"], denyTools: ["Write"], approvalRequired: false } }),
    catalog(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.warnings.some((warning) => /denied but also allowlisted/.test(warning)));
});

test("isKnownModel accepts catalog ids and provider/model pairs only", () => {
  assert.equal(isKnownModel(PREFERRED), true);
  assert.equal(isKnownModel(`anthropic/${PREFERRED}`), true);
  assert.equal(isKnownModel("definitely-not-a-model"), false);
});

test("stripSecrets removes secret-shaped keys at every depth", () => {
  const dirty = {
    agent: {
      name: "bot",
      apiKey: "sk-live-should-never-ship",
      nested: { authorization: "Bearer x", token: "abc", keep: "yes" },
      list: [{ password: "hunter2", value: 1 }],
      credentialId: "nope",
    },
  };
  const clean = stripSecrets(dirty) as Record<string, any>;
  assert.equal(clean.agent.apiKey, undefined);
  assert.equal(clean.agent.nested.authorization, undefined);
  assert.equal(clean.agent.nested.token, undefined);
  assert.equal(clean.agent.nested.keep, "yes");
  assert.equal(clean.agent.list[0].password, undefined);
  assert.equal(clean.agent.list[0].value, 1);
  assert.equal(clean.agent.credentialId, undefined);
  assert.equal(containsSecretKeys(clean), false);
  assert.equal(containsSecretKeys(dirty), true);
  assert.doesNotMatch(JSON.stringify(clean), /sk-live-should-never-ship/);
});

test("store round-trips, lists and deletes an agent", () => {
  const saved = saveAgent("alice", manifest(), catalog());
  assert.equal(saved.ok, true);
  const loaded = getAgent("alice", "triage-bot");
  assert.ok(loaded);
  assert.equal(loaded?.name, "Triage bot");
  assert.deepEqual(listAgents("alice").map((row) => row.id), ["triage-bot"]);
  // Another account never sees it.
  assert.equal(getAgent("bob", "triage-bot"), null);
  assert.equal(deleteAgent("alice", "triage-bot"), true);
  assert.equal(getAgent("alice", "triage-bot"), null);
  assert.equal(deleteAgent("alice", "triage-bot"), false);
});

test("an invalid manifest is never persisted", () => {
  const saved = saveAgent("alice", manifest({ id: "bad id" }), catalog());
  assert.equal(saved.ok, false);
  assert.deepEqual(listAgents("alice"), []);
});

test("history keeps the previous version and is capped", () => {
  const base = manifest();
  assert.equal(saveAgent("alice", base, catalog()).ok, true);
  assert.equal(saveAgent("alice", { ...base, name: "Triage bot v2" }, catalog()).ok, true);
  const history = getAgentHistory("alice", "triage-bot");
  assert.equal(history.length, 1);
  assert.equal(history[0].manifest.name, "Triage bot");

  // 21 further saves must not grow the history past the cap.
  for (let i = 0; i < AGENT_HISTORY_LIMIT + 1; i += 1) {
    assert.equal(saveAgent("alice", { ...base, name: `rev ${i}` }, catalog()).ok, true);
  }
  assert.equal(getAgentHistory("alice", "triage-bot").length, AGENT_HISTORY_LIMIT);
});

test("restoreAgentVersion puts a previous version back", () => {
  const base = manifest();
  saveAgent("alice", base, catalog());
  saveAgent("alice", { ...base, name: "Renamed" }, catalog());
  const restored = restoreAgentVersion("alice", "triage-bot", 0, catalog());
  assert.equal(restored.ok, true);
  assert.equal(getAgent("alice", "triage-bot")?.name, "Triage bot");
  // The rename is now itself in history, so a restore is reversible.
  assert.equal(getAgentHistory("alice", "triage-bot")[0].manifest.name, "Renamed");
  const missing = restoreAgentVersion("alice", "triage-bot", 99, catalog());
  assert.equal(missing.ok, false);
});

test("cloneAgent copies under a new id and name", () => {
  saveAgent("alice", manifest(), catalog());
  const cloned = cloneAgent("alice", "triage-bot", "triage-bot-2", catalog());
  assert.equal(cloned.ok, true);
  if (!cloned.ok) return;
  assert.equal(cloned.manifest.id, "triage-bot-2");
  assert.equal(cloned.manifest.name, "Triage bot (copy)");
  assert.equal(listAgents("alice").length, 2);
});

test("importAgent strips secrets, de-dupes the id and skips unknown skills", () => {
  const dirty = {
    format: "swarm-agent",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    agent: {
      ...manifest({ id: "imported" }),
      apiKey: "sk-should-be-dropped",
      models: { preferred: PREFERRED, fallbacks: [], token: "nope" },
      skills: ["skill-one", "not-installed"],
    },
  };
  const first = importAgent("alice", dirty, catalog());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.manifest.id, "imported");
  assert.equal("apiKey" in first.manifest, false);
  assert.deepEqual(first.manifest.skills, ["skill-one"]);
  assert.ok(first.warnings.some((warning) => /not-installed/.test(warning)));

  const second = importAgent("alice", dirty, catalog());
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.manifest.id, "imported-2");
});

test("exportAgent ships a clean package and re-scans clean", () => {
  saveAgent("alice", manifest(), catalog());
  const pkg = exportAgent("alice", "triage-bot");
  assert.ok(pkg);
  assert.equal(pkg?.format, "swarm-agent");
  assert.equal(pkg?.formatVersion, 1);
  assert.equal(exportContainsSecrets(pkg!), false);
  assert.doesNotMatch(JSON.stringify(pkg), /api[_-]?key|token|secret|password|authorization|credential/i);
});

test("compatibilityReport names unsupported tools and unknown models", () => {
  const report = compatibilityReport(
    {
      ...(validateManifest(manifest(), catalog()) as { ok: true; manifest: AgentManifest }).manifest,
      tools: ["Read", "Teleport"],
      models: { preferred: "ghost-model", fallbacks: [] },
    },
    { userId: "alice" },
  );
  assert.ok(report.missing.some((entry) => /tool Teleport is not supported/.test(entry)));
  assert.ok(report.missing.some((entry) => /ghost-model is not in the provider catalog/.test(entry)));
  assert.ok(report.supported.some((entry) => /tool Read/.test(entry)));
});

test("compatibilityReport treats unknown MCP servers and connectors as warnings", () => {
  const validated = validateManifest(manifest({ connectors: ["jira"] }), catalog());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  // No account context: nothing about skills can be decided, so nothing blocks.
  const report = compatibilityReport(validated.manifest);
  assert.ok(report.warnings.some((entry) => /connector jira/.test(entry)));
  assert.equal(report.missing.length, 0);
});

test("compatibilityReport blocks when the account does not own the skills", () => {
  const validated = validateManifest(manifest(), catalog());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const report = compatibilityReport(validated.manifest, { userId: "alice" });
  assert.ok(report.missing.some((entry) => /skill skill-one is not installed in this account/.test(entry)));
});

test("effectiveToolAllowlist intersects the harness and honours denyTools", () => {
  const validated = validateManifest(
    manifest({ tools: ["Read", "Terraria"], permissions: { allowTools: ["Edit", "Read"], denyTools: ["Edit"], approvalRequired: false } }),
    catalog(),
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const allow = effectiveToolAllowlist(validated.manifest);
  assert.ok(allow.includes("Read"));
  assert.equal(allow.includes("Terraria"), false, "unknown tools are never passed to the runtime");
  assert.equal(allow.includes("Edit"), false, "denied tools are never passed to the runtime");
  assert.ok(harnessTools().includes("Bash"));
});

test("buildDeployPrompt carries the system prompt first and the tool list", () => {
  const validated = validateManifest(manifest(), catalog());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const prompt = buildDeployPrompt(validated.manifest);
  assert.ok(prompt.startsWith("You triage incoming issues"));
  assert.match(prompt, /Tools available to you: Read, Grep, Bash/);
  assert.match(prompt, /Never use: Write/);
  assert.match(prompt, /Skills installed for this run/);
});

function deployable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return manifest({ skills: [], workflows: [], context: [], ...overrides });
}

test("deploy refuses an incompatible manifest and never calls the harness", async () => {
  let called = 0;
  const manager = { start: () => { called += 1; return { accepted: true, runId: "run_x", queued: false }; } };
  const validated = validateManifest(deployable({ tools: ["Read", "Teleport"] }), catalog());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const result = await swarmAdapter.deploy("alice", validated.manifest, {
    manager: manager as unknown as RuntimeManager,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.missing?.some((entry) => /Teleport/.test(entry)));
  assert.equal(called, 0);
});

test("deploy starts a run with the model and the intersection of tools", async () => {
  const calls: Array<{ userId: string; input: Record<string, unknown> }> = [];
  const manager = {
    start: (userId: string, input: Record<string, unknown>) => {
      calls.push({ userId, input });
      return { accepted: true, runId: "run_deployed", queued: false };
    },
  };
  const validated = validateManifest(deployable(), catalog());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const result = await swarmAdapter.deploy("alice", validated.manifest, {
    manager: manager as unknown as RuntimeManager,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.runId, "run_deployed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.model, PREFERRED);
  const allowlist = calls[0].input.toolAllowlist as string[];
  assert.ok(allowlist.includes("Read"));
  assert.equal(allowlist.includes("Write"), false, "a denied tool must not reach the runtime");
});
