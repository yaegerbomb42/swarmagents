import { PRESETS, TOOL_PRESETS, MCP_PRESETS, type Preset, type ToolPreset, type McpPreset } from "../presets";
import { KEY_PATTERNS } from "./key-detect";

/**
 * Enhanced Provider & Connector Catalog.
 * Enriches presets with deep links, hints, and capability tags.
 */

export interface EnrichedPreset extends Preset {
  keyHelpHint?: string;
  directKeyUrl?: string;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
}

export function getEnrichedPresets(): EnrichedPreset[] {
  return PRESETS.map((p) => {
    const pattern = KEY_PATTERNS.find((k) => k.preset === p.id || k.kind === p.kind);
    return {
      ...p,
      directKeyUrl: p.keyUrl || pattern?.keyUrl,
      keyHelpHint: pattern?.hint || (p.needsKey ? `Generate an API key in your ${p.label} account.` : undefined),
      supportsStreaming: true,
      supportsTools: p.kind !== "perplexity", // Perplexity does not support tool calling in standard mode
    };
  });
}
