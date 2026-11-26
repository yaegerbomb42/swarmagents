import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSERVATIVE_CAPABILITIES,
  isDesktopRunMode,
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

test("run mode is text-desktop for a model without vision when the desktop is on", () => {
  const noVision = runModeForCapabilities(
    { vision: false, tools: true, computerUse: false },
    { desktopEnabled: true },
  );
  assert.equal(noVision.mode, "text-desktop");
  assert.equal(noVision.label, "Text desktop mode");
  assert.match(noVision.reason, /no vision/i);
  assert.match(noVision.reason, /describe_screen/i);

  // Desktop off still means plain text, even without vision.
  const desktopOff = runModeForCapabilities(
    { vision: false, tools: true, computerUse: false },
    { desktopEnabled: false },
  );
  assert.equal(desktopOff.mode, "text");
});

test("run mode is text for a vision model without computer use", () => {
  const noComputer = runModeForCapabilities(
    { vision: true, tools: true, computerUse: false },
    { desktopEnabled: true },
  );
  assert.equal(noComputer.mode, "text");
  assert.match(noComputer.reason, /cannot use computer tools/i);
});

test("isDesktopRunMode wires the desktop for gui and text-desktop only", () => {
  assert.equal(isDesktopRunMode(undefined), true);
  assert.equal(isDesktopRunMode("gui"), true);
  assert.equal(isDesktopRunMode("text-desktop"), true);
  assert.equal(isDesktopRunMode("text"), false);
  assert.equal(isDesktopRunMode("chat"), false);
});

test("run mode is gui only when vision, tools and computer use are all present", () => {
  const info = runModeForCapabilities(
    { vision: true, tools: true, computerUse: true },
    { desktopEnabled: true },
  );
  assert.equal(info.mode, "gui");
  assert.equal(info.label, "Desktop mode");
});

test("presets carry documented output-token caps for hosted families", () => {
  assert.equal(presetModelCapabilities("anthropic", "claude-sonnet-4-5").maxOutputTokens, 64_000);
  assert.equal(presetModelCapabilities("anthropic", "claude-3-7-sonnet-20250219").maxOutputTokens, 64_000);
  assert.equal(presetModelCapabilities("anthropic", "claude-3-5-sonnet-20241022").maxOutputTokens, 8_192);
  assert.equal(presetModelCapabilities("anthropic", "claude-3-opus-20240229").maxOutputTokens, 4_096);

  assert.equal(presetModelCapabilities("openai", "gpt-5").maxOutputTokens, 128_000);
  assert.equal(presetModelCapabilities("openai", "gpt-4.1").maxOutputTokens, 32_768);
  assert.equal(presetModelCapabilities("openai", "gpt-4o-mini").maxOutputTokens, 16_384);
  assert.equal(presetModelCapabilities("openai", "o3").maxOutputTokens, 100_000);
  assert.equal(presetModelCapabilities("openai", "gpt-3.5-turbo").maxOutputTokens, 4_096);

  assert.equal(presetModelCapabilities("gemini", "gemini-2.5-pro").maxOutputTokens, 65_536);
  assert.equal(presetModelCapabilities("gemini", "gemini-2.0-flash").maxOutputTokens, 8_192);

  assert.equal(presetModelCapabilities("mistral", "mistral-large-latest").maxOutputTokens, 8_192);
  assert.equal(presetModelCapabilities("deepseek", "deepseek-chat").maxOutputTokens, 8_192);
  assert.equal(presetModelCapabilities("deepseek", "deepseek-reasoner").maxOutputTokens, 65_536);
  assert.equal(presetModelCapabilities("cohere", "command-r-plus").maxOutputTokens, 4_096);

  // Unknown/local models have no known cap: the gateway leaves max_tokens alone.
  assert.equal(presetModelCapabilities("ollama", "llama3.2:3b").maxOutputTokens, undefined);
  assert.equal(presetModelCapabilities("custom", "mystery-model").maxOutputTokens, undefined);
});

test("a saved maxOutputTokens override wins over the preset", () => {
  const merged = mergedModelCapabilities(
    {
      id: "openai",
      modelCapabilities: {
        "gpt-4o": { vision: true, tools: true, computerUse: true, maxOutputTokens: 2_048 },
      },
    },
    "gpt-4o",
  );
  assert.equal(merged.maxOutputTokens, 2_048);
});
