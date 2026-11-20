/**
 * Tests for the Agent Studio's pure logic.
 *
 * The builder component has no DOM test setup in this repo (node:test, no
 * jsdom), so everything that can be wrong — form ↔ manifest mapping, search,
 * compatibility presentation — lives in agentForm.ts and is covered here. The
 * component itself is verified by typecheck, like TeamPanel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  digestCompatibility,
  EMPTY_FORM,
  filterAgents,
  formFromManifest,
  idFromName,
  manifestFromForm,
  type AgentFormState,
} from "./agentForm";
import type { AgentManifest } from "../../../lib/agents/manifest";
import type { AgentSummary } from "../../../lib/client/agents";

const MANIFEST: AgentManifest = {
  version: 1,
  id: "triage-bot",
  name: "Triage bot",
  description: "Routes issues.",
  identity: { systemPrompt: "You triage.", tone: "terse" },
  models: { preferred: "model-a", fallbacks: ["model-b"] },
  tools: ["Read", "Grep"],
  mcp: [{ name: "library-tools", transport: "stdio", command: "node server.mjs" }],
  connectors: ["github"],
  context: ["skill-one"],
  memory: { policy: "persistent", maxEntries: 25 },
  skills: ["skill-one"],
  workflows: [],
  policies: { maxTurns: 20, maxCostUsd: 1.5 },
  permissions: { allowTools: ["Read"], denyTools: ["Bash"], approvalRequired: true },
  subagents: [{ name: "researcher", instructions: "Find context.", tools: ["Read"] }],
};

function summary(partial: Partial<AgentSummary>): AgentSummary {
  return { id: "a", name: "A", version: 1, updatedAt: 0, ...partial };
}

test("formFromManifest maps every section, and a missing manifest yields the empty form", () => {
  assert.deepEqual(formFromManifest(null), EMPTY_FORM);
  const form = formFromManifest(MANIFEST);
  assert.equal(form.id, "triage-bot");
  assert.equal(form.systemPrompt, "You triage.");
  assert.equal(form.preferredModel, "model-a");
  assert.deepEqual(form.fallbackModels, ["model-b"]);
  assert.deepEqual(form.tools, ["Read", "Grep"]);
  assert.equal(form.mcp[0].command, "node server.mjs");
  assert.equal(form.context, "skill-one");
  assert.equal(form.memoryPolicy, "persistent");
  assert.equal(form.maxEntries, "25");
  assert.equal(form.maxTurns, "20");
  assert.equal(form.maxCostUsd, "1.5");
  assert.equal(form.approvalRequired, true);
  assert.deepEqual(form.denyTools, ["Bash"]);
  assert.equal(form.subagents[0].tools, "Read");
});

test("manifestFromForm round-trips a manifest without losing or inventing fields", () => {
  const rebuilt = manifestFromForm(formFromManifest(MANIFEST));
  assert.equal(rebuilt.id, MANIFEST.id);
  assert.equal(rebuilt.identity.systemPrompt, MANIFEST.identity.systemPrompt);
  assert.equal(rebuilt.identity.tone, "terse");
  assert.deepEqual(rebuilt.models, MANIFEST.models);
  assert.deepEqual(rebuilt.tools, MANIFEST.tools);
  assert.deepEqual(rebuilt.mcp, MANIFEST.mcp);
  assert.deepEqual(rebuilt.context, MANIFEST.context);
  assert.deepEqual(rebuilt.memory, MANIFEST.memory);
  assert.deepEqual(rebuilt.policies, MANIFEST.policies);
  assert.deepEqual(rebuilt.subagents, MANIFEST.subagents);
  assert.equal(rebuilt.permissions.approvalRequired, true);
});

test("manifestFromForm trims input and omits blank optional numbers and rows", () => {
  const form: AgentFormState = {
    ...EMPTY_FORM,
    id: "  ",
    name: "  Spacey  ",
    systemPrompt: "  prompt  ",
    preferredModel: "  model-a  ",
    context: " a, b ,  ",
    maxEntries: "   ",
    maxCostUsd: "not-a-number",
    mcp: [{ name: "  ", transport: "http", command: "", url: "https://x" }],
    subagents: [{ name: "  ", instructions: "x", tools: "" }],
  };
  const manifest = manifestFromForm(form);
  assert.equal(manifest.name, "Spacey");
  assert.equal(manifest.identity.systemPrompt, "  prompt  ", "the prompt is passed through verbatim");
  assert.equal(manifest.models.preferred, "model-a");
  assert.deepEqual(manifest.context, ["a", "b"]);
  assert.equal("maxEntries" in manifest.memory, false);
  assert.equal("maxCostUsd" in manifest.policies, false);
  assert.deepEqual(manifest.mcp, [], "a nameless MCP row is dropped");
  assert.deepEqual(manifest.subagents, [], "a nameless subagent is dropped");
});

test("an http MCP row stores its url, a stdio row its command", () => {
  const manifest = manifestFromForm({
    ...EMPTY_FORM,
    id: "x",
    name: "X",
    preferredModel: "model-a",
    mcp: [
      { name: "s1", transport: "stdio", command: "node a.mjs", url: "https://ignored" },
      { name: "s2", transport: "http", command: "ignored", url: "https://example.test/mcp" },
    ],
  });
  assert.deepEqual(manifest.mcp, [
    { name: "s1", transport: "stdio", command: "node a.mjs" },
    { name: "s2", transport: "http", url: "https://example.test/mcp" },
  ]);
});

test("filterAgents searches name and description, case-insensitively", () => {
  const agents = [
    summary({ id: "triage", name: "Triage bot", description: "Routes issues" }),
    summary({ id: "reviewer", name: "Reviewer", description: "Reviews PRs" }),
  ];
  assert.deepEqual(filterAgents(agents, "").map((a) => a.id), ["triage", "reviewer"]);
  assert.deepEqual(filterAgents(agents, "  ").map((a) => a.id), ["triage", "reviewer"]);
  assert.deepEqual(filterAgents(agents, "ROUTES").map((a) => a.id), ["triage"]);
  assert.deepEqual(filterAgents(agents, "review").map((a) => a.id), ["reviewer"]);
  assert.deepEqual(filterAgents(agents, "nothing here"), []);
});

test("digestCompatibility separates blockers from warnings", () => {
  const blocked = digestCompatibility({ supported: ["tool Read"], missing: ["tool Teleport is not supported"], warnings: [] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.headline, /1 problem blocks deployment/);
  assert.deepEqual(blocked.missing, ["tool Teleport is not supported"]);

  const warned = digestCompatibility({ supported: [], missing: [], warnings: ["connector jira is not available"] });
  assert.equal(warned.ok, true);
  assert.match(warned.headline, /Ready to deploy with 1 warning/);

  const clean = digestCompatibility({ supported: ["tool Read"], missing: [], warnings: [] });
  assert.equal(clean.ok, true);
  assert.equal(clean.headline, "Ready to deploy");
});

test("idFromName slugifies a display name", () => {
  assert.equal(idFromName("Triage Bot!"), "triage-bot");
  assert.equal(idFromName("  Multi   word  "), "multi-word");
  assert.equal(idFromName("already-a-slug"), "already-a-slug");
  assert.equal(idFromName("!!!"), "");
});
