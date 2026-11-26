/**
 * Model capability presets and run-mode gating.
 *
 * Pure data + pure functions: safe to import from the settings UI as well as
 * the server. Capabilities come from three places, in increasing priority:
 *
 *   1. the preset table below (known hosted models),
 *   2. discovery (e.g. Ollama /api/show "capabilities"),
 *   3. a per-model manual override saved on the provider config.
 *
 * A provider with no capability information is treated conservatively: it can
 * call tools (most OpenAI-compatible servers can), but it has no vision, so a
 * run starts in text-desktop mode — the desktop is wired, but the model
 * drives it through text (describe_screen + accessibility snapshots)
 * instead of screenshots.
 */

import type { ModelCapabilities, ProviderConfig, RunMode } from "./types";

/** Safe default for a model we know nothing about. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  vision: false,
  tools: true,
  computerUse: false,
  source: "preset",
};

const VISION_NAME = /(?:^|[-_/.:])(vision|vl|llava|pixtral|internvl|minicpm-v|gemma3)(?:[-_/.:]|$)|(?:qwen2(?:\.5)?-vl)|(?:llama-?3\.2.*vision)|(?:llama-?4.*(?:scout|maverick))/i;
const NO_TOOLS_NAME = /(?:^|[-_/])(?:embed|embedding|rerank|whisper|tts)(?:[-_/]|$)/i;

const ANTHROPIC_VISION = /claude-(?:3|3\.5|3\.7|4|sonnet-4|opus-4|haiku-4)/i;
const ANTHROPIC_COMPUTER = /claude-(?:3\.5|3\.7|4|sonnet-4|opus-4|haiku-4)/i;
const OPENAI_VISION = /(?:gpt-4o|gpt-4\.1|gpt-5|o3|o4|chatgpt-4o)/i;
const OPENAI_COMPUTER = /(?:gpt-4o|gpt-4\.1|gpt-5|computer-use)/i;
const GEMINI_VISION = /gemini-(?:1\.5|2|2\.5|3)/i;

/** Capability preset for a provider id + model id. */
export function presetModelCapabilities(providerId: string, model: string): ModelCapabilities {
  const id = providerId.toLowerCase();
  const m = model.toLowerCase();

  if (NO_TOOLS_NAME.test(m)) {
    return { vision: false, tools: false, computerUse: false, source: "preset" };
  }

  const namedVision = VISION_NAME.test(m);

  if (id === "anthropic" || id === "radium") {
    const vision = ANTHROPIC_VISION.test(m);
    // Documented Anthropic output caps: Claude 4 family 64k, 3.7 Sonnet 64k,
    // 3.5 family 8k, Claude 3 family 4k.
    const maxOutputTokens = /claude-(?:4|sonnet-4|opus-4|haiku-4)/.test(m)
      ? 64_000
      : /claude-3[-.]7/.test(m)
        ? 64_000
        : /claude-3[-.]5/.test(m)
          ? 8_192
          : 4_096;
    return {
      vision,
      tools: true,
      computerUse: vision && ANTHROPIC_COMPUTER.test(m),
      contextWindow: 200_000,
      maxOutputTokens,
      source: "preset",
    };
  }

  if (id === "openai" || id === "azure-openai") {
    const vision = OPENAI_VISION.test(m);
    // Documented OpenAI output caps, most specific family first.
    const maxOutputTokens = /gpt-5/.test(m)
      ? 128_000
      : /gpt-4\.1/.test(m)
        ? 32_768
        : /gpt-4o/.test(m)
          ? 16_384
          : /(?:^|[-_/])o[34](?:[-_/]|$)/.test(m)
            ? 100_000
            : /(?:gpt-4|gpt-3\.5|chatgpt)/.test(m)
              ? 4_096
              : undefined;
    return {
      vision,
      tools: true,
      computerUse: vision && OPENAI_COMPUTER.test(m),
      contextWindow: 200_000,
      maxOutputTokens,
      source: "preset",
    };
  }

  if (id === "gemini") {
    const vision = GEMINI_VISION.test(m);
    return {
      vision,
      tools: true,
      computerUse: vision,
      contextWindow: 1_000_000,
      // Gemini 2.5/3 allow 65k output tokens; 1.5/2.0 cap at 8k.
      maxOutputTokens: /gemini-(?:2\.5|3)/.test(m) ? 65_536 : 8_192,
      source: "preset",
    };
  }

  if (id === "xai") {
    const vision = /grok-(?:2|3|4)/i.test(m);
    return {
      vision,
      tools: true,
      computerUse: vision,
      contextWindow: 256_000,
      source: "preset",
    };
  }

  if (id === "mistral") {
    return {
      vision: /pixtral|mistral-small-3|magistral.*vision/i.test(m),
      tools: true,
      computerUse: false,
      contextWindow: 128_000,
      // Mistral's API caps max_tokens at 8192 for its hosted models.
      maxOutputTokens: 8_192,
      source: "preset",
    };
  }

  if (id === "cohere") {
    return {
      vision: false,
      tools: true,
      computerUse: false,
      contextWindow: 128_000,
      // Command R / R+ cap output at 4096 tokens.
      maxOutputTokens: 4_096,
      source: "preset",
    };
  }

  if (id === "deepseek") {
    return {
      vision: false,
      tools: true,
      computerUse: false,
      contextWindow: 128_000,
      // deepseek-chat caps output at 8192; deepseek-reasoner allows 65536.
      maxOutputTokens: /reasoner/.test(m) ? 65_536 : 8_192,
      source: "preset",
    };
  }

  // Local runtimes (Ollama, LM Studio) and open-weights routers: only trust the
  // model name, and only for vision. Tool support is common but not universal;
  // Ollama discovery refines it from /api/show.
  return {
    vision: namedVision,
    tools: true,
    computerUse: false,
    source: "preset",
  };
}

/** Capabilities for a model on a provider: preset, overlaid by saved overrides. */
export function mergedModelCapabilities(
  config: Pick<ProviderConfig, "id" | "modelCapabilities">,
  model: string,
): ModelCapabilities {
  const override = config.modelCapabilities?.[model];
  if (override) {
    return { ...presetModelCapabilities(config.id, model), ...override, source: "override" };
  }
  return presetModelCapabilities(config.id, model);
}

/** True when a saved capability map overrides any field for this model. */
export function hasCapabilityOverride(
  config: Pick<ProviderConfig, "modelCapabilities">,
  model: string,
): boolean {
  return config.modelCapabilities?.[model] !== undefined;
}

export interface RunModeInfo {
  mode: RunMode;
  /** Short badge text, e.g. "Text mode". */
  label: string;
  /** Full sentence explaining why, shown as a title/tooltip and in telemetry. */
  reason: string;
  provider?: string;
  model?: string;
  capabilities: ModelCapabilities;
}

/**
 * Decide how a run should behave for the selected model.
 *
 * `desktopEnabled` is the deployment's desktop switch (SWARM_VM_DESKTOP=1).
 * With it on, a model without vision gets text-desktop mode: the desktop
 * MCP servers are wired, but the model drives them through text
 * (describe_screen + accessibility snapshots) instead of screenshots. A
 * model with vision but without computer-use support runs headless with
 * shell/files/web/MCP tools.
 */
export function runModeForCapabilities(
  capabilities: ModelCapabilities,
  options: {
    desktopEnabled: boolean;
    provider?: string;
    model?: string;
  },
): RunModeInfo {
  const base = {
    capabilities,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
  };

  if (!capabilities.tools) {
    return {
      ...base,
      mode: "chat",
      label: "Plain chat",
      reason: "Plain chat: this model cannot call tools.",
    };
  }
  if (!options.desktopEnabled) {
    return {
      ...base,
      mode: "text",
      label: "Text mode",
      reason: "Text mode: the desktop is off for this deployment.",
    };
  }
  if (!capabilities.vision) {
    return {
      ...base,
      mode: "text-desktop",
      label: "Text desktop mode",
      reason:
        "Text desktop mode: this model has no vision, so it drives the desktop through text " +
        "(describe_screen + accessibility snapshots) instead of screenshots.",
    };
  }
  if (!capabilities.computerUse) {
    return {
      ...base,
      mode: "text",
      label: "Text mode",
      reason: "Text mode: this model cannot use computer tools.",
    };
  }
  return {
    ...base,
    mode: "gui",
    label: "Desktop mode",
    reason: "Desktop mode: vision and computer-use tools are enabled.",
  };
}

/**
 * True when a run mode wires the desktop MCP servers. `undefined` is the
 * legacy default (a run created before modes existed behaves like gui).
 * Text-desktop wires the same servers as gui — the difference is how the
 * model sees the screen (text, not screenshots), enforced downstream.
 */
export function isDesktopRunMode(mode: RunMode | undefined): boolean {
  return mode === undefined || mode === "gui" || mode === "text-desktop";
}
