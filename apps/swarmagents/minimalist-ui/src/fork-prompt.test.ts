import assert from "node:assert/strict";
import { test } from "node:test";

import { FORK_PROMPT_MAX_LEN, forkPromptFromSearch } from "./fork-prompt";

test("?prompt= is extracted, trimmed and bounded; its absence is null", () => {
  assert.equal(forkPromptFromSearch("?prompt=Build%20a%20landing%20page"), "Build a landing page");
  assert.equal(forkPromptFromSearch("?prompt=%20%20hello%20%20"), "hello");
  assert.equal(forkPromptFromSearch(""), null);
  assert.equal(forkPromptFromSearch("?dev=1"), null);
  assert.equal(forkPromptFromSearch("?prompt="), null);
  assert.equal(forkPromptFromSearch("?prompt=%20%20"), null);
});

test("a forked prompt longer than the cap is truncated, never rejected", () => {
  const long = "x".repeat(FORK_PROMPT_MAX_LEN + 500);
  const parsed = forkPromptFromSearch(`?prompt=${encodeURIComponent(long)}`);
  assert.ok(parsed);
  assert.equal(parsed.length, FORK_PROMPT_MAX_LEN);
});

test("multiline prompts survive URL encoding", () => {
  const prompt = "Fix the failing test\nthen run the full suite";
  assert.equal(forkPromptFromSearch(`?prompt=${encodeURIComponent(prompt)}`), prompt);
});
