import { z } from "zod";

export const CapabilityKindSchema = z.enum([
  "mcp_tool",
  "mcp_resource",
  "mcp_prompt",
  "cli",
  "desktop_app",
  "ai_provider",
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const RiskLevelSchema = z.enum([
  "read-only",
  "writes-files",
  "network",
  "destructive",
]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const CapabilityEntrySchema = z.object({
  id: z.string().min(1),
  kind: CapabilityKindSchema,
  name: z.string().min(1),
  summary: z.string().min(1).max(100),
  risk: RiskLevelSchema,
  schema: z.record(z.string(), z.unknown()).optional(),
  source: z.string().min(1),
});
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const RegistryCacheSchema = z.object({
  version: z.literal(1),
  lastRefreshedAt: z.iso.datetime(),
  entries: z.array(CapabilityEntrySchema),
});
export type RegistryCache = z.infer<typeof RegistryCacheSchema>;

export function truncateSummary(text: string, maxLen = 100): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned || "No description available";
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}
