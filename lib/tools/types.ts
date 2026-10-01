import type { ImageData, PlanItem } from "../types";
import type { ToolSpec } from "../providers/types";

export interface ToolContext {
  sessionId: string;
  cwd: string;
  setCwd(cwd: string): void;
  signal: AbortSignal;
  /** Stream live output into the tool's UI card. */
  onOutput(chunk: string): void;
  setPlan(items: PlanItem[]): void;
}

export interface ToolResult {
  content: string;
  images?: ImageData[];
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Keep the model's view of big outputs bounded: head + tail, full text spilled to disk. */
export function clip(text: string, max = 30_000, spill?: (full: string) => string): string {
  if (text.length <= max) return text;
  const where = spill ? `\n[full output saved to ${spill(text)}]` : "";
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} chars omitted]${where} …\n\n${text.slice(-half)}`;
}
