import assert from "node:assert/strict";
import test from "node:test";
import {
  clearOnlineSkillsCache,
  fetchOnlineSkillMd,
  listOnlineSkills,
  searchOnlineSkills,
} from "./skills-registry";

test("listOnlineSkills aggregates Anthropic, OpenAI, and Composio trees and caches queries", async () => {
  clearOnlineSkillsCache();
  let calls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("anthropics/skills")) {
      return new Response(
        JSON.stringify({
          tree: [
            { path: "skills/frontend-design/SKILL.md", type: "blob" },
            { path: "skills/mcp-builder/SKILL.md", type: "blob" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("openai/skills")) {
      return new Response(
        JSON.stringify({
          tree: [{ path: "skills/.curated/cloudflare-deploy/SKILL.md", type: "blob" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        tree: [{ path: "composio-skills/github-automation/SKILL.md", type: "blob" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const all = await listOnlineSkills("", { fetchImpl: fakeFetch });
  assert.equal(all.length, 4);
  const filtered = await searchOnlineSkills("cloudflare", { fetchImpl: fakeFetch });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.skills[0].id, "openai/cloudflare-deploy");
  assert.equal(calls, 3, "three repo fetches once, then served from TTL cache");

  const composioOnly = await searchOnlineSkills("", { source: "composio", fetchImpl: fakeFetch });
  assert.equal(composioOnly.total, 1);
  assert.equal(composioOnly.skills[0].id, "composio/github-automation");
});

test("fetchOnlineSkillMd fetches bare legacy id and source-qualified SKILL.md", async () => {
  clearOnlineSkillsCache();
  const seenUrls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    seenUrls.push(String(input));
    return new Response(
      "---\nname: mcp-builder\ndescription: Build MCP servers cleanly.\n---\n# Guide\nSteps...",
      { status: 200 },
    );
  };
  const legacy = await fetchOnlineSkillMd("mcp-builder", { fetchImpl: fakeFetch });
  assert.equal(legacy.id, "anthropic/mcp-builder");
  assert.equal(legacy.slug, "mcp-builder");
  assert.equal(legacy.description, "Build MCP servers cleanly.");
  assert.match(legacy.skillMd, /# Guide/);
  assert.ok(seenUrls[0].includes("anthropics/skills/main/skills/mcp-builder/SKILL.md"));
});

test("fetchOnlineSkillMd rejects traversal or malformed skill ids", async () => {
  await assert.rejects(
    () => fetchOnlineSkillMd("../etc/passwd"),
    /Invalid skill id/i,
  );
});
