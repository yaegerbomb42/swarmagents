import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSERVATIVE_CAPABILITIES,
  mergedModelCapabilities,
  presetModelCapabilities,
  runModeForCapabilities,
} from "./capabilities";

test("presets know which hosted models can see and use a computer", () => {
  const claude = presetModelCapabilities("anthropic", "claude-sonnet-4-5");
  assert.equal(claude.vision, true);
  assert.equal(claude.tools, true);
  assert.equal(claude.computerUse, true);
  assert.equal(claude.contextWindow, 200_000);

  const deepseek = presetModelCapabilities("deepseek", "deepseek-chat");
  assert.equal(deepseek.vision, false);
  assert.equal(deepseek.tools, true);
  assert.equal(deepseek.computerUse, false);

  const gpt = presetModelCapabilities("openai", "gpt-4o");
  assert.equal(gpt.vision, true);
  assert.equal(gpt.computerUse, true);
});

test("open-weights vision is inferred from the model name", () => {
  assert.equal(presetModelCapabilities("ollama", "llava:13b").vision, true);
  assert.equal(presetModelCapabilities("ollama", "qwen2.5-vl:7b").vision, true);
  assert.equal(presetModelCapabilities("ollama", "llama3.2:3b").vision, false);
  assert.equal(presetModelCapabilities("ollama", "nomic-embed-text").tools, false);
});

test("saved overrides win over presets and force source=override", () => {
  const merged = mergedModelCapabilities(
    {
      id: "custom",
      modelCapabilities: {
        "my-model": { vision: true, tools: false, computerUse: false, source: "override" },
      },
    },
    "my-model",
  );
  assert.deepEqual(
    { vision: merged.vision, tools: merged.tools, computerUse: merged.computerUse, source: merged.source },
    { vision: true, tools: false, computerUse: false, source: "override" },
  );
});

test("unknown models fall back to conservative capabilities", () => {
  const info = mergedModelCapabilities({ id: "custom" }, "mystery-model");
  assert.equal(info.vision, CONSERVATIVE_CAPABILITIES.vision);
  assert.equal(info.tools, CONSERVATIVE_CAPABILITIES.tools);
  assert.equal(info.computerUse, CONSERVATIVE_CAPABILITIES.computerUse);
});

test("run mode is chat when the model cannot call tools", () => {
  const info = runModeForCapabilities(
    { vision: false, tools: false, computerUse: false },
    { desktopEnabled: true, provider: "p", model: "m" },
  );
  assert.equal(info.mode, "chat");
  assert.match(info.reason, /cannot call tools/i);
  assert.equal(info.provider, "p");
  assert.equal(info.model, "m");
});

test("run mode is text when the deployment desktop is off", () => {
  const info = runModeForCapabilities(
    { vision: true, tools: true, computerUse: true },
    { desktopEnabled: false },
  );
  assert.equal(info.mode, "text");
  assert.match(info.reason, /desktop is off/i);
});

test("run mode is text for a model without vision or computer use", () => {
  const noVision = runModeForCapabilities(
    { vision: false, tools: true, computerUse: false },
    { desktopEnabled: true },
  );
  assert.equal(noVision.mode, "text");
  assert.match(noVision.reason, /no vision/i);

  const noComputer = runModeForCapabilities(
    { vision: true, tools: true, computerUse: false },
    { desktopEnabled: true },
  );
  assert.equal(noComputer.mode, "text");
  assert.match(noComputer.reason, /cannot use computer tools/i);
});

test("run mode is gui only when vision, tools and computer use are all present", () => {
  const info = runModeForCapabilities(
    { vision: true, tools: true, computerUse: true },
    { desktopEnabled: true },
  );
  assert.equal(info.mode, "gui");
  assert.equal(info.label, "Desktop mode");
});
