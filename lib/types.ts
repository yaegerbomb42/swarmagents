// Shared types between the agent runtime (server) and the UI (client).

/** "anthropic" uses the native API; every other kind speaks the OpenAI-compatible protocol. */
export type ProviderKind = string;

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  enabled: boolean;
  /** Catalog entry this connection was created from (lib/presets.ts id). Defaults to `kind`. */
  preset?: string;
  /** Extra request headers. Values may contain "{key}", replaced with apiKey at request time. */
  headers?: Record<string, string>;
  /** Last live model list, cached for the picker. */
  models?: string[];
}

/** Provider as sent to the browser: the key is masked. */
export interface PublicProvider extends Omit<ProviderConfig, "apiKey"> {
  keyHint: string;
  limits: LearnedLimits;
}

export interface LearnedLimits {
  /** Requests/minute at which we were last throttled (lowest observed). */
  rpm?: number;
  /** Input tokens/minute at which we were last throttled (lowest observed). */
  tpm?: number;
  throttles: number;
  lastThrottleAt?: number;
  cooldownUntil?: number;
  contextWindow?: number;
  lastError?: string;
}

// ---- Conversation history (provider-neutral) ----

export interface ImageData {
  mediaType: string;
  data: string; // base64
}

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string; model?: string; redacted?: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean; images?: ImageData[] }
  | { type: "image"; image: ImageData };

export interface Msg {
  role: "user" | "assistant";
  blocks: Block[];
}

// ---- UI event stream (everything the agent does, visible) ----

export interface Attachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

export type AgentEvent =
  | { id: string; ts: number; type: "user"; text: string; attachments?: Attachment[] }
  | { id: string; ts: number; type: "thinking"; text: string; done?: boolean; endTs?: number }
  | { id: string; ts: number; type: "text"; text: string; done?: boolean }
  | {
      id: string;
      ts: number;
      type: "tool";
      name: string;
      input: unknown;
      inputPreview?: string;
      status: "streaming" | "running" | "ok" | "error";
      output?: string;
      images?: ImageData[];
      endTs?: number;
    }
  | { id: string; ts: number; type: "compaction"; before: number; after: number; summary: string; reason: string; done?: boolean }
  | { id: string; ts: number; type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { id: string; ts: number; type: "plan"; items: PlanItem[] }
  | { id: string; ts: number; type: "turn"; provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; stop: string };

export interface PlanItem {
  text: string;
  status: "pending" | "active" | "done";
}

export type AppendField = "text" | "output" | "inputPreview" | "summary";

export type StreamOp =
  | { op: "snapshot"; events: AgentEvent[]; running: boolean; meta: SessionMeta; context: ContextInfo }
  | { op: "add"; event: AgentEvent }
  | { op: "patch"; id: string; patch: Partial<AgentEvent>; append?: { field: AppendField; value: string } }
  | { op: "running"; running: boolean }
  | { op: "context"; context: ContextInfo };

export interface ContextInfo {
  tokens: number;
  window: number;
  provider?: string;
  model?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  /** True while a run is in progress; a run still marked active at boot was cut off and is resumed. */
  active?: boolean;
  /** Latest plan, kept across runs so the agent can be held to it. */
  plan?: PlanItem[];
  /** Older events moved to the append-only archive; the live stream holds only the rest. */
  archivedEvents?: number;
}
