import test from "node:test";
import assert from "node:assert/strict";
import { buildDomainPlaybook, DEFAULT_PLAYBOOK_MAX_TOKENS, detectTaskDomains } from "./domain-playbooks";

test("detectTaskDomains matches Blender, Docs, Data, Media, and Web prompts", () => {
  assert.deepEqual(detectTaskDomains("Create a 3D scene in Blender and render it"), ["blender"]);
  assert.deepEqual(detectTaskDomains("Convert report.docx to PDF using LibreOffice"), ["docs"]);
  assert.deepEqual(detectTaskDomains("Load sales.csv in pandas and plot a matplotlib chart"), ["data"]);
  assert.deepEqual(detectTaskDomains("Trim intro.mp4 with ffmpeg and make a gif"), ["media"]);
  assert.deepEqual(detectTaskDomains("Scrape the pricing website with Playwright"), ["web"]);
});

test("buildDomainPlaybook returns empty for unrelated coding/general prompts", () => {
  const out = buildDomainPlaybook("Fix the TypeScript compiler error in src/index.ts and run unit tests");
  assert.deepEqual(out.domains, []);
  assert.equal(out.text, "");
  assert.equal(out.estimatedTokens, 0);
});

test("buildDomainPlaybook enforces the 250-token cap even on multi-domain prompts", () => {
  const multi = buildDomainPlaybook(
    "Scrape a website with Playwright, plot the csv in matplotlib, render a Blender 3D scene, convert slides to pdf with LibreOffice, and encode an mp4 with ffmpeg",
  );
  assert.ok(multi.domains.length >= 2);
  assert.ok(multi.estimatedTokens <= DEFAULT_PLAYBOOK_MAX_TOKENS);
  assert.ok(multi.text.length <= DEFAULT_PLAYBOOK_MAX_TOKENS * 4);
});
