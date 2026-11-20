import test from "node:test";
import assert from "node:assert/strict";
import {
  formatLensCost,
  hasMermaidBlock,
  isLensResult,
  lensResultKey,
  messageFingerprint,
  rememberedLens,
  rememberLens,
} from "./lenses";
import { LENSES, lensDefinition, LENS_IDS, isLensId } from "../lenses/types";

test("the lens catalogue holds the five lenses, in menu order", () => {
  assert.deepEqual([...LENS_IDS], ["eli5", "executive", "code-review", "security", "architecture"]);
  assert.deepEqual(
    LENSES.map((lens) => lens.label),
    ["ELI5", "Executive summary", "Code review", "Security audit", "Architecture diagram"],
  );
  for (const lens of LENSES) {
    assert.equal(lensDefinition(lens.id).id, lens.id);
    assert.ok(lens.hint.length > 0);
  }
  assert.equal(isLensId("eli5"), true);
  assert.equal(isLensId("interpret-dreams"), false);
  assert.equal(isLensId(undefined), false);
});

test("the client cache key depends on the message and the lens, and never holds the text", () => {
  const key = lensResultKey("the router retries the next key", "eli5");
  assert.match(key, /^eli5:[0-9a-f]+-[0-9a-f]{8}$/);
  assert.equal(key.includes("router"), false);
  assert.notEqual(key, lensResultKey("the router retries the next key", "security"));
  assert.notEqual(key, lensResultKey("another message", "eli5"));
  // The same message always gives the same key.
  assert.equal(key, lensResultKey("the router retries the next key", "eli5"));
  assert.notEqual(messageFingerprint("a"), messageFingerprint("b"));
});

test("an answer remembered in this session is returned for the same message and lens", () => {
  const key = lensResultKey("remember me", "executive");
  assert.equal(rememberedLens(key), undefined);
  rememberLens(key, {
    lens: "executive",
    text: "The short version.",
    provider: "openai",
    model: "gpt-4.1-mini",
    costUsd: 0.001,
    latencyMs: 120,
    cached: false,
    createdAt: Date.now(),
  });
  assert.equal(rememberedLens(key)?.text, "The short version.");
  assert.equal(rememberedLens(lensResultKey("remember me", "eli5")), undefined);
});

test("a lens cost is formatted for display", () => {
  assert.equal(formatLensCost(0), "$0");
  assert.equal(formatLensCost(null), "—");
  assert.equal(formatLensCost(undefined), "—");
  assert.equal(formatLensCost(0.0012), "$0.0012");
  assert.equal(formatLensCost(0.25), "$0.250");
});

test("only a real lens answer is accepted", () => {
  assert.equal(isLensResult({ lens: "eli5", text: "x", provider: "openai", model: "m" }), true);
  assert.equal(isLensResult({ lens: "nope", text: "x", provider: "openai", model: "m" }), false);
  assert.equal(isLensResult({ lens: "eli5", text: 5, provider: "openai", model: "m" }), false);
  assert.equal(isLensResult(null), false);
});

test("a mermaid block is recognised in an answer", () => {
  assert.equal(hasMermaidBlock("```mermaid\nflowchart TD\n A-->B\n```"), true);
  assert.equal(hasMermaidBlock("```Mermaid\nflowchart TD\n A-->B\n```"), true);
  assert.equal(hasMermaidBlock("no diagram here"), false);
  assert.equal(hasMermaidBlock(""), false);
});
