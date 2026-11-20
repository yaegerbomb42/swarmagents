/** Pure event-to-view reducer used by the finished-run replay surface. */
export interface ReplayEvent {
  seq: number;
  type: string;
  ts: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface ReplayState {
  seq: number;
  terminal: string;
  reasoning: string;
  files: Array<{ path: string; change: string }>;
  screenshotUrl?: string;
  markers: Array<{ seq: number; type: ReplayMarkerType; label: string }>;
  error?: string;
}

export type ReplayMarkerType = "bash" | "edit" | "browser" | "llm" | "error" | "approval" | "checkpoint";

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const eventData = (e: ReplayEvent) => ({ ...record(e.data), ...e });

export function replayMarker(e: ReplayEvent): { type: ReplayMarkerType; label: string } | null {
  const d = eventData(e);
  if (e.type === "tool.call") {
    const name = text(d.name).toLowerCase();
    const input = record(d.input);
    const edit = /write|edit|patch|file/.test(name) || typeof input.file_path === "string";
    return { type: edit ? "edit" : "bash", label: text(d.name) || "tool" };
  }
  if (e.type === "tool.result" && d.ok === false) return { type: "error", label: "tool error" };
  if (e.type === "browser.frame" || e.type.startsWith("browser.")) return { type: "browser", label: "browser" };
  if (e.type.startsWith("llm.")) return { type: "llm", label: "LLM" };
  if (e.type.startsWith("approval.")) return { type: "approval", label: "approval" };
  if (e.type === "checkpoint.created") return { type: "checkpoint", label: text(d.label) || "checkpoint" };
  if (e.type === "checkpoint.restored") return { type: "checkpoint", label: `forked from ${text(d.label) || "checkpoint"}` };
  if (e.type === "run.error") return { type: "error", label: "run error" };
  return null;
}

/** Reduce events through the requested sequence. Safe to call for any seq. */
export function reduceRunReplay(events: readonly ReplayEvent[], seq: number): ReplayState {
  const state: ReplayState = { seq, terminal: "", reasoning: "", files: [], markers: [] };
  const files = new Map<string, string>();
  for (const e of events) {
    if (e.seq > seq) break;
    const d = eventData(e);
    const marker = replayMarker(e);
    if (marker) state.markers.push({ seq: e.seq, ...marker });
    if (e.type === "assistant.text") state.reasoning += `${text(d.text)}\n`;
    if (e.type === "tool.result") {
      const output = text(d.output);
      if (output) state.terminal += `${output}\n`;
    }
    if (e.type === "tool.call") {
      const input = record(d.input);
      const path = text(input.file_path ?? input.path);
      const name = text(d.name).toLowerCase();
      if (path && /write|edit|patch|file/.test(name)) {
        const oldText = text(input.old_string ?? input.oldText);
        const newText = text(input.new_string ?? input.newText ?? input.content);
        const patch = oldText || newText
          ? `${oldText ? oldText.split("\n").map((line) => `- ${line}`).join("\n") : ""}${oldText && newText ? "\n" : ""}${newText ? newText.split("\n").map((line) => `+ ${line}`).join("\n") : ""}`
          : text(input.patch) || "(file changed; diff not recorded)";
        files.set(path, patch.slice(0, 20_000));
      }
    }
    if (e.type === "browser.frame" && typeof d.screenshotDataUrl === "string" && d.screenshotDataUrl.startsWith("data:image/")) {
      state.screenshotUrl = d.screenshotDataUrl;
    }
    if (e.type === "run.error") state.error = text(d.message) || "Run failed";
  }
  state.files = [...files].map(([path, change]) => ({ path, change }));
  return state;
}
