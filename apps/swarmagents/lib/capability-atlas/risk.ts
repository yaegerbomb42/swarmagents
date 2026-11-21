import type { CapabilityKind, RiskLevel } from "./schema";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

const DESTRUCTIVE_RE =
  /\b(rm|rmdir|delete|destroy|drop|wipe|format|kill|pkill|shutdown|reboot|purge|truncate|reset|force|sudo|chmod|chown|mkfs|dd)\b/i;

const NETWORK_RE =
  /\b(http|https|curl|wget|fetch|request|upload|download|push|pull|deploy|publish|sync|ssh|scp|rsync|email|send|post|slack|discord|github|gh|pr|issue|api|cloud|aws|gcloud|az|kubectl|docker|yt-dlp|web|browser|search|scrape|provider)\b/i;

const WRITES_FILES_RE =
  /\b(write|save|create|edit|modify|update|convert|render|encode|export|compress|extract|unzip|tar|install|build|compile|format|lint|fix|patch|mkdir|mv|cp|touch|tee|ffmpeg|blender|pandoc|convert|magick|gs|soffice)\b/i;

export function classifyRisk(params: {
  name: string;
  summary: string;
  kind: CapabilityKind;
  annotations?: McpToolAnnotations;
}): RiskLevel {
  const { name, summary, kind, annotations } = params;

  if (annotations) {
    if (annotations.destructiveHint === true) return "destructive";
    if (annotations.readOnlyHint === true) {
      return annotations.openWorldHint === true ? "network" : "read-only";
    }
    if (annotations.openWorldHint === true) return "network";
  }

  if (kind === "ai_provider") return "network";
  if (kind === "mcp_resource" || kind === "mcp_prompt") return "read-only";

  const haystack = `${name} ${summary}`;
  if (DESTRUCTIVE_RE.test(haystack)) return "destructive";
  if (NETWORK_RE.test(haystack)) return "network";
  if (WRITES_FILES_RE.test(haystack)) return "writes-files";

  return "read-only";
}
