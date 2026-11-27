/**
 * Wire-format translation between the Anthropic Messages API and the OpenAI
 * Chat Completions API.
 *
 * The agent inside a user's VM speaks only the Anthropic Messages API. Most
 * non-Anthropic providers (Inception Mercury, Mistral, Groq, OpenAI, ...)
 * speak the OpenAI Chat Completions wire format instead. This module
 * translates in both directions:
 *
 *   request:  Anthropic -> OpenAI   (system, content blocks text/image,
 *            tools <-> functions, tool_use/tool_result <-> tool_calls/tool role,
 *            tool_choice, tool_result is_error, max_tokens clamped to the
 *            target model's known output cap)
 *   response: OpenAI -> Anthropic    (content blocks, tool_use from
 *            tool_calls, stop_reason mapping, usage mapping)
 *   SSE:     OpenAI chunks -> Anthropic events (message_start /
 *            content_block_start / content_block_delta / content_block_stop /
 *            message_delta / message_stop)
 *
 * It is pure: no I/O, no provider keys, no platform imports. See
 * llm-gateway.ts for the failover/forwarding layer that uses it.
 */

import { randomUUID } from "node:crypto";

/** Thrown when an Anthropic request cannot be translated. */
export class BridgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeValidationError";
  }
}

/** Optional translation limits resolved by the caller (the gateway). */
export interface BridgeOptions {
  /**
   * Hard cap on output tokens for the target model, when known. A request
   * asking for more is clamped down to the cap so the upstream provider
   * never rejects it as oversized. Undefined, zero, negative, or
   * non-finite = no clamp; the request value passes through unchanged.
   */
  maxOutputTokens?: number;
  /**
   * Whether the target model supports vision/image inputs. When explicitly
   * `false`, raw image blocks (in user messages or tool_result payloads) are
   * replaced with structured text placeholders before wire translation so
   * text-only upstreams never reject the turn with HTTP 400.
   */
  vision?: boolean;
  /**
   * When true, Anthropic `thinking` blocks in assistant messages are
   * translated to the OpenAI `reasoning_content` field on the assistant
   * message instead of being dropped, so the model's reasoning survives
   * across multi-turn tool loops. Only set for providers known to accept
   * the field (DeepSeek, Qwen, Grok, GLM, Moonshot, and Ollama, whose
   * shim maps it onto the native `thinking` field). Every other provider
   * gets the blocks stripped, so a strict upstream never sees an unknown
   * field. Default: strip.
   */
  reasoningContent?: boolean;
}

function imagePlaceholderText(block: Record<string, unknown>): string {
  const source = isRecord(block.source) ? block.source : {};
  const sourceType = asString(source.type) ?? "unknown";
  if (sourceType === "base64") {
    const mediaType = asString(source.media_type) ?? "image/png";
    const data = asString(source.data) ?? "";
    const approxBytes = Math.floor((data.length * 3) / 4);
    return `[image omitted: model lacks vision; mediaType=${mediaType}; bytes=${approxBytes}]`;
  }
  if (sourceType === "url") {
    return "[image omitted: model lacks vision; source=url]";
  }
  return `[image omitted: model lacks vision; source=${sourceType}]`;
}

function stripImagesFromBlocks(blocks: unknown[]): { blocks: unknown[]; changed: boolean } {
  let changed = false;
  const next = blocks.map((rawBlock) => {
    if (!isRecord(rawBlock)) return rawBlock;
    if (rawBlock.type === "image") {
      changed = true;
      return { type: "text", text: imagePlaceholderText(rawBlock) };
    }
    if (rawBlock.type === "tool_result" && Array.isArray(rawBlock.content)) {
      const inner = stripImagesFromBlocks(rawBlock.content);
      if (inner.changed) {
        changed = true;
        return { ...rawBlock, content: inner.blocks };
      }
    }
    return rawBlock;
  });
  return changed ? { blocks: next, changed: true } : { blocks, changed: false };
}

/**
 * Replace Anthropic `image` content blocks (including nested `tool_result`
 * images) with structured text placeholders for non-vision models.
 * Pure and non-mutating: returns `body` unchanged when no images are present.
 */
/**
 * Drop `thinking` blocks that carry no `signature` from assistant messages.
 * The bridge synthesizes thinking blocks from other providers'
 * reasoning_content without a signature; Claude Code echoes them back, and
 * the real Anthropic API rejects unsigned thinking with HTTP 400 ("Invalid
 * signature in thinking block") after a failover onto an Anthropic-wire
 * provider. Signed blocks (genuine Anthropic thinking) and
 * redacted_thinking are kept. Pure; returns `body` unchanged when nothing is
 * dropped. An assistant message left empty gets an empty text block so the
 * user/assistant alternation stays valid.
 */
export function stripUnsignedThinking(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((rawMsg) => {
    if (!isRecord(rawMsg) || rawMsg.role !== "assistant" || !Array.isArray(rawMsg.content)) return rawMsg;
    const kept = rawMsg.content.filter(
      (b) =>
        !(
          isRecord(b) &&
          b.type === "thinking" &&
          (typeof b.signature !== "string" || b.signature.length === 0)
        ),
    );
    if (kept.length === rawMsg.content.length) return rawMsg;
    changed = true;
    return { ...rawMsg, content: kept.length > 0 ? kept : [{ type: "text", text: "" }] };
  });
  return changed ? { ...body, messages } : body;
}

export function stripAnthropicImages(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((rawMsg) => {
    if (!isRecord(rawMsg) || !Array.isArray(rawMsg.content)) return rawMsg;
    const stripped = stripImagesFromBlocks(rawMsg.content);
    if (!stripped.changed) return rawMsg;
    changed = true;
    return { ...rawMsg, content: stripped.blocks };
  });
  return changed ? { ...body, messages } : body;
}

/**
 * Clamp a requested max_tokens to the target model's output cap.
 * The value is floored first (matching the previous pass-through behavior);
 * an unknown cap leaves it untouched.
 */
export function clampMaxTokens(maxTokens: number, cap: number | undefined): number {
  const floored = Math.floor(maxTokens);
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return floored;
  return Math.min(floored, Math.floor(cap));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Synthesize a stable, non-empty tool-call id for providers that omit one. */
export function ensureToolCallId(id: unknown): string {
  const value = asString(id);
  return value !== undefined && value.length > 0 ? value : `call_${randomUUID().slice(0, 8)}`;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

/**
 * Return a suffix that turns `input` into a valid JSON document, or `null`
 * when `input` cannot be completed by appending characters (it is not a valid
 * JSON prefix). OpenAI-compatible providers sometimes truncate tool-call
 * arguments mid-string; appending the returned suffix keeps the Anthropic
 * SSE stream's tool input parseable instead of aborting `claude -p`.
 *
 * The scanner is deliberately lenient about *incomplete* values (a number
 * without digits, a half-written escape, an open container) and strict about
 * values that can never become valid (a stray character, a bad escape,
 * trailing garbage after a complete document).
 */
export function jsonCompletionSuffix(input: string): string | null {
  let start = 0;
  while (start < input.length && isWhitespace(input[start]!)) start += 1;
  if (start === input.length) return "{}";
  let i = 0;
  const n = input.length;
  const ws = (): void => {
    while (i < n && isWhitespace(input[i]!)) i += 1;
  };

  // Called with input[i] === '"'. Returns the suffix needed to close the
  // string, or null for an invalid escape.
  const stringSuffix = (): string | null => {
    i += 1;
    while (i < n) {
      const ch = input[i++]!;
      if (ch === '"') return "";
      // Raw control characters are never legal inside a JSON string, even
      // though the scanner would otherwise treat them as ordinary content.
      if (ch.charCodeAt(0) < 0x20) return null;
      if (ch === "\\") {
        if (i >= n) return 'u0000"'; // dangling backslash: encode NUL, close
        const esc = input[i++]!;
        if (esc === "u") {
          let digits = 0;
          while (i < n && digits < 4 && isHexDigit(input[i]!)) {
            i += 1;
            digits += 1;
          }
          if (digits < 4) return "0".repeat(4 - digits) + '"';
        } else if (!'"\\/bfnrt'.includes(esc)) {
          return null;
        }
      }
    }
    return '"'; // unterminated string
  };

  const literalSuffix = (word: string): string | null => {
    let k = 0;
    while (i < n && k < word.length) {
      if (input[i] !== word[k]) return null;
      i += 1;
      k += 1;
    }
    return word.slice(k);
  };

  const numberSuffix = (): string | null => {
    if (input[i] === "-") {
      i += 1;
      if (i >= n) return "0";
    }
    if (i >= n || !isDigit(input[i]!)) return null;
    if (input[i] === "0") i += 1;
    else while (i < n && isDigit(input[i]!)) i += 1;
    if (i < n && input[i] === ".") {
      i += 1;
      if (i >= n) return "0";
      if (!isDigit(input[i]!)) return null;
      while (i < n && isDigit(input[i]!)) i += 1;
    }
    if (i < n && (input[i] === "e" || input[i] === "E")) {
      i += 1;
      if (i < n && (input[i] === "+" || input[i] === "-")) i += 1;
      if (i >= n) return "0";
      if (!isDigit(input[i]!)) return null;
      while (i < n && isDigit(input[i]!)) i += 1;
    }
    return "";
  };

  let valueSuffix: () => string | null;
  let objectSuffix: () => string | null;
  let arraySuffix: () => string | null;

  objectSuffix = (): string | null => {
    i += 1; // opening brace
    ws();
    if (i >= n) return "}";
    if (input[i] === "}") {
      i += 1;
      return "";
    }
    for (;;) {
      ws();
      if (i >= n) return '"":null}'; // key not started yet
      if (input[i] !== '"') return null;
      const key = stringSuffix();
      if (key !== "") return key + ":null}"; // unterminated key
      ws();
      if (i >= n) return ":null}";
      if (input[i] !== ":") return null;
      i += 1;
      const value = valueSuffix();
      if (value === null) return null;
      if (value !== "") return value + "}";
      ws();
      if (i >= n) return "}";
      if (input[i] === "}") {
        i += 1;
        return "";
      }
      if (input[i] !== ",") return null;
      i += 1;
      ws();
      if (i >= n) return '"":null}'; // trailing comma
    }
  };

  arraySuffix = (): string | null => {
    i += 1; // opening bracket
    ws();
    if (i >= n) return "]";
    if (input[i] === "]") {
      i += 1;
      return "";
    }
    for (;;) {
      const value = valueSuffix();
      if (value === null) return null;
      if (value !== "") return value + "]";
      ws();
      if (i >= n) return "]";
      if (input[i] === "]") {
        i += 1;
        return "";
      }
      if (input[i] !== ",") return null;
      i += 1;
      ws();
      if (i >= n) return "null]"; // trailing comma
    }
  };

  valueSuffix = (): string | null => {
    ws();
    if (i >= n) return "null";
    const ch = input[i]!;
    if (ch === '"') return stringSuffix();
    if (ch === "{") return objectSuffix();
    if (ch === "[") return arraySuffix();
    if (ch === "t") return literalSuffix("true");
    if (ch === "f") return literalSuffix("false");
    if (ch === "n") return literalSuffix("null");
    if (ch === "-" || isDigit(ch)) return numberSuffix();
    return null;
  };

  const suffix = valueSuffix();
  if (suffix === null) return null;
  ws();
  return i < n ? null : suffix;
}

/**
 * Escape raw control characters (newline, tab, ...) that some providers emit
 * *inside* JSON strings. That is the one lossless repair: every character the
 * model produced survives, it is only re-encoded.
 */
function escapeRawControlCharsInStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/**
 * The suffix that closes `input` *without changing any value in it*, or null.
 *
 * Only open objects/arrays may be closed. A prefix that ends inside a string
 * (`{"command":"rm -rf /home/user/old-bu`), a half-written literal or key, a
 * dangling `:`/`,`, or a number at the very end (which may itself be cut
 * short: `{"timeout":12` of `1200`) is NOT completed: running a tool with a
 * silently shortened command, path or file body is worse than failing the
 * call and letting the model re-issue it.
 */
export function safeClosingSuffix(input: string): string | null {
  const suffix = jsonCompletionSuffix(input);
  if (suffix === null) return null;
  if (!/^[\]}]*$/.test(suffix)) return null;
  if (suffix.length > 0 && /[\d.eE+-]$/.test(input.trimEnd())) return null;
  return suffix;
}

/** Why a provider's tool arguments could not be used as sent. */
export type ToolArgumentsProblem = "truncated" | "malformed";

/**
 * Normalize a provider's tool arguments to a JSON string the Anthropic SDK
 * can always parse, never changing what the model asked for:
 *
 *   - valid JSON passes through byte-identically;
 *   - raw control characters inside strings are escaped (lossless);
 *   - a prefix that only lacks closing braces/brackets is closed;
 *   - anything else (a cut-off string/number/literal, garbage) becomes `{}`,
 *     so the tool fails input validation and the model retries, instead of
 *     executing a different, shortened command. `problem` says why.
 */
export function normalizeToolArguments(value: unknown): { json: string; problem?: ToolArgumentsProblem } {
  if (typeof value !== "string") {
    try {
      return { json: JSON.stringify(value ?? {}) };
    } catch {
      return { json: "{}", problem: "malformed" };
    }
  }
  if (value.trim().length === 0) return { json: "{}" };
  const parses = (text: string): boolean => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  if (parses(value)) return { json: value };
  const escaped = escapeRawControlCharsInStrings(value);
  if (escaped !== value && parses(escaped)) return { json: escaped };
  const suffix = safeClosingSuffix(escaped);
  if (suffix !== null && parses(escaped + suffix)) return { json: escaped + suffix };
  return { json: "{}", problem: jsonCompletionSuffix(escaped) !== null ? "truncated" : "malformed" };
}

/** {@link normalizeToolArguments}, returning only the JSON string. */
export function repairToolArguments(value: unknown): string {
  return normalizeToolArguments(value).json;
}

/** Text the model sees when a tool call's arguments were unusable. */
export function toolArgumentsNotice(name: string, id: string, problem: ToolArgumentsProblem): string {
  const why =
    problem === "truncated"
      ? "the provider cut the arguments off before they were complete"
      : "the provider returned arguments that are not valid JSON";
  return (
    `[tool call ${name || "(unnamed)"} (${id}) was not run with its arguments: ${why}. ` +
    "It was sent with empty input instead. Re-issue the call with complete arguments; " +
    "for large file contents, write the file in smaller pieces.]"
  );
}

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function mapStopReason(finishReason: unknown): string | null {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return null;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = isRecord(part) ? part : {};
        const text = asString(block.text);
        if (text !== undefined) return text;
        return "";
      })
      .join("");
  }
  return "";
}

/** OpenAI content parts for Anthropic text/image blocks. */
function openaiContentParts(blocks: unknown[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const b = isRecord(block) ? block : {};
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" && isRecord(b.source) && b.source.type === "base64") {
      const mediaType = asString(b.source.media_type) ?? "image/png";
      const data = asString(b.source.data) ?? "";
      parts.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } });
    }
    // Unknown block types are dropped: they carry no OpenAI equivalent.
  }
  return parts;
}

/** One Anthropic content block -> OpenAI content (string or parts array). */
function openaiUserContent(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = openaiContentParts(content);
    if (parts.length === 0) return "";
    if (parts.every((part) => part.type === "text")) {
      return (parts as { text: string }[]).map((part) => part.text).join("");
    }
    return parts;
  }
  return "";
}

/** Anthropic tool_result block -> OpenAI tool message content. */
function openaiToolContent(content: unknown): string | Record<string, unknown>[] {
  return openaiUserContent(content);
}

// ---------------------------------------------------------------------------
// Tool JSON Schema sanitizer (per-target dialects)
// ---------------------------------------------------------------------------

/**
 * Target wire dialect for {@link sanitizeToolJsonSchema}. Every style the
 * gateway bridges to except `anthropic` (which needs no reshaping).
 */
export type SchemaDialect = "openai-chat" | "openai-responses" | "gemini" | "ollama";

/**
 * Meta keywords Claude Code emits that at least one upstream dialect rejects
 * with HTTP 400. They carry no tool-argument semantics, so they are stripped
 * for every dialect.
 */
const SCHEMA_META_KEYWORDS = [
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "$recursiveRef",
  "$dynamicRef",
] as const;

/** Keywords Gemini and Ollama/llama.cpp reject but OpenAI-wire APIs accept. */
const SCHEMA_NONSTRICT_KEYWORDS = ["default", "examples"] as const;

/** `format` values the OpenAI wire accepts; others are dropped. */
const OPENAI_FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uuid",
]);

/** Gemini's documented `format` support for strings. */
const GEMINI_FORMATS = new Set(["enum", "date-time"]);

/** Long tool descriptions (Claude Code emits some >10k chars) hit provider limits. */
const MAX_DESCRIPTION_CHARS = 500;

/** Several strict dialects cap object property counts far below JSON Schema's. */
const MAX_PROPERTIES = 64;

/** Guard against pathologically nested schemas; deeper subtrees become `{}`. */
const MAX_SCHEMA_DEPTH = 16;

function isNullTypeSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "null") return true;
  return Array.isArray(value.type) && value.type.length > 0 && value.type.every((t) => t === "null");
}

/** `type` widened to include null; undefined when it cannot be expressed. */
function nullableType(type: unknown): unknown {
  if (typeof type === "string" && type !== "") return [type, "null"];
  if (Array.isArray(type) && type.length > 0) {
    return type.includes("null") ? type : [...type, "null"];
  }
  return undefined;
}

function allowedFormats(dialect: SchemaDialect): Set<string> | undefined {
  switch (dialect) {
    case "gemini":
      return GEMINI_FORMATS;
    case "ollama":
      return new Set();
    case "openai-chat":
    case "openai-responses":
      return OPENAI_FORMATS;
  }
}

/**
 * Deterministically reshape one tool input schema for a target dialect.
 *
 * Claude Code's tool schemas are rich JSON Schemas ($schema, nested
 * anyOf/oneOf nullable wrappers, exotic formats, long descriptions, huge
 * property lists) that OpenAI strict mode, Gemini generateContent, Ollama,
 * Groq and Mistral frequently reject with HTTP 400. The sanitizer:
 *
 *   - strips meta keywords ($schema, $id, ...) for every dialect;
 *   - strips `default`/`examples` where unsupported (gemini, ollama);
 *   - drops `format` values the dialect does not accept;
 *   - flattens a trivial anyOf/oneOf nullable wrapper (exactly one
 *     {"type":"null"} branch) into the dialect's null representation:
 *     a `type` array on the OpenAI wire, `nullable: true` on Gemini, and a
 *     dropped null variant on Ollama (whose grammar has no null);
 *   - caps description length and object property count (first N win, and
 *     `required` is filtered to the survivors);
 *   - caps recursion depth; deeper subtrees become a permissive `{}`.
 *
 * Pure and non-mutating; best-effort by design — the output is always a
 * usable schema-like object and never throws.
 */
export function sanitizeToolJsonSchema(schema: unknown, dialect: SchemaDialect): unknown {
  return sanitizeSchemaNode(schema, dialect, 0);
}

function sanitizeSchemaNode(node: unknown, dialect: SchemaDialect, depth: number): unknown {
  if (!isRecord(node)) return node;
  if (depth > MAX_SCHEMA_DEPTH) return {};

  const out: Record<string, unknown> = { ...node };
  for (const key of SCHEMA_META_KEYWORDS) delete out[key];
  if (dialect === "gemini" || dialect === "ollama") {
    for (const key of SCHEMA_NONSTRICT_KEYWORDS) delete out[key];
  }

  const formats = allowedFormats(dialect);
  if (formats !== undefined && !formats.has(String(out.format))) delete out.format;

  // Type arrays: the OpenAI wire accepts them; Gemini and llama.cpp do not.
  // Collapse deterministically to a single type and express null via
  // `nullable` (Gemini) or by dropping the null variant (Ollama).
  if (Array.isArray(out.type) && dialect !== "openai-chat" && dialect !== "openai-responses") {
    const hadNull = out.type.includes("null");
    const nonNull = out.type.filter((t) => t !== "null");
    if (nonNull.length >= 1) {
      out.type = nonNull[0];
      if (dialect === "gemini" && hadNull) out.nullable = true;
    }
  }

  if (typeof out.description === "string" && out.description.length > MAX_DESCRIPTION_CHARS) {
    out.description = out.description.slice(0, MAX_DESCRIPTION_CHARS);
  }

  // Trivial nullable wrapper: exactly one null-type branch next to real ones.
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = out[key];
    if (!Array.isArray(branches)) continue;
    const records = branches.filter(isRecord);
    const rest = records.filter((b) => !isNullTypeSchema(b));
    if (records.length - rest.length !== 1 || rest.length === 0) continue;
    const sanitizedRest = rest.map((b) => sanitizeSchemaNode(b, dialect, depth + 1));
    delete out[key];
    if (sanitizedRest.length === 1) {
      Object.assign(out, sanitizedRest[0]);
    } else {
      out[key] = sanitizedRest;
    }
    if (dialect === "gemini") {
      out.nullable = true;
    } else if (dialect === "openai-chat" || dialect === "openai-responses") {
      if (sanitizedRest.length === 1) {
        const widened = nullableType(out.type);
        if (widened !== undefined) out.type = widened;
      }
    }
    // ollama: the null variant is simply dropped; its grammar cannot
    // represent a null-typed argument.
  }

  const props = out.properties;
  if (isRecord(props)) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (Object.keys(kept).length >= MAX_PROPERTIES) break;
      kept[key] = sanitizeSchemaNode(value, dialect, depth + 1);
    }
    out.properties = kept;
    if (Object.keys(kept).length < Object.keys(props).length && Array.isArray(out.required)) {
      const required = out.required.filter((r) => typeof r === "string" && r in kept);
      if (required.length > 0) out.required = required;
      else delete out.required;
    }
  }

  if (out.items !== undefined) out.items = sanitizeSchemaNode(out.items, dialect, depth + 1);
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((b) => sanitizeSchemaNode(b, dialect, depth + 1));
  }
  if (isRecord(out.additionalProperties)) {
    out.additionalProperties = sanitizeSchemaNode(out.additionalProperties, dialect, depth + 1);
  }
  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.map((b) => sanitizeSchemaNode(b, dialect, depth + 1));
  }
  if (isRecord(out.not)) out.not = sanitizeSchemaNode(out.not, dialect, depth + 1);
  if (isRecord(out.contains)) out.contains = sanitizeSchemaNode(out.contains, dialect, depth + 1);

  return out;
}

/** Anthropic tools array -> OpenAI tools (functions). */
function anthropicToolsToOpenAI(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const tool of tools) {
    const t = isRecord(tool) ? tool : {};
    // Anthropic tools: {name, description?, input_schema}. Custom providers may
    // already use the OpenAI shape {type:"function", function:{...}}.
    if (t.type === "function" && isRecord(t.function)) {
      const fn = { ...t.function };
      if (fn.parameters !== undefined) {
        fn.parameters = sanitizeToolJsonSchema(fn.parameters, "openai-chat");
      }
      out.push({ ...t, function: fn });
      continue;
    }
    const name = asString(t.name);
    if (!name) continue;
    const fn: Record<string, unknown> = { name };
    if (asString(t.description) !== undefined) fn.description = t.description;
    if (t.input_schema !== undefined) {
      fn.parameters = sanitizeToolJsonSchema(t.input_schema, "openai-chat");
    }
    out.push({ type: "function", function: fn });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Anthropic tool_choice -> OpenAI tool_choice (+ parallel_tool_calls).
 *
 * Anthropic: {type:"auto"|"any"|"none"} or {type:"tool", name}, each
 * optionally with disable_parallel_tool_use. OpenAI: "auto"|"required"|
 * "none" or {type:"function", function:{name}}, plus parallel_tool_calls.
 * Custom providers may already send the OpenAI shape; it passes through.
 * Unknown shapes yield nothing (never emit an invalid upstream payload).
 */
function anthropicToolChoiceToOpenAI(toolChoice: unknown): {
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
} {
  if (toolChoice === undefined || toolChoice === null) return {};
  if (typeof toolChoice === "string") {
    return ["auto", "none", "required"].includes(toolChoice) ? { toolChoice } : {};
  }
  const tc = isRecord(toolChoice) ? toolChoice : {};
  const parallel = tc.disable_parallel_tool_use === true ? false : undefined;
  switch (tc.type) {
    case "auto":
      return { toolChoice: "auto", parallelToolCalls: parallel };
    case "any":
      return { toolChoice: "required", parallelToolCalls: parallel };
    case "none":
      return { toolChoice: "none" };
    case "tool": {
      const name = asString(tc.name);
      return name
        ? { toolChoice: { type: "function", function: { name } }, parallelToolCalls: parallel }
        : {};
    }
    case "function": {
      // Pre-shaped OpenAI named-tool choice.
      const fn = isRecord(tc.function) ? tc.function : {};
      return asString(fn.name) ? { toolChoice: tc } : {};
    }
    default:
      return {};
  }
}

/** Concatenated text of Anthropic `thinking` blocks in an assistant message.
 * `redacted_thinking` blocks are opaque (encrypted reasoning) and are never
 * carried: there is no text to preserve and no provider could use them. */
function thinkingText(blocks: unknown[]): string {
  let out = "";
  for (const block of blocks) {
    const b = isRecord(block) ? block : {};
    if (b.type === "thinking" && typeof b.thinking === "string") out += b.thinking;
  }
  return out;
}

/** Index of the last user message that carries more than tool results (-1 if none). */
function lastRealUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = isRecord(messages[i]) ? (messages[i] as Record<string, unknown>) : {};
    if ((asString(m.role) ?? "user") !== "user") continue;
    const content = m.content;
    if (!Array.isArray(content)) return i;
    if (content.some((b) => !(isRecord(b) && (b as Record<string, unknown>).type === "tool_result"))) return i;
  }
  return -1;
}

/** Anthropic assistant message -> OpenAI assistant message (with tool_calls).
 * Returns null when the message reduces to nothing downstream (a
 * thinking-only message with no text and no tool calls): emitting a bare
 * `{role:"assistant"}` would be rejected by strict upstreams, and dropping
 * it is safe because no tool message depends on it. */
function anthropicAssistantMessage(
  message: Record<string, unknown>,
  options: BridgeOptions,
): Record<string, unknown> | null {
  const content = message.content;
  const blocks = Array.isArray(content) ? content : [];
  const texts = blocks.filter((b) => isRecord(b) && (b as Record<string, unknown>).type === "text");
  const toolUses = blocks.filter((b) => isRecord(b) && (b as Record<string, unknown>).type === "tool_use");

  if (texts.length === 0 && toolUses.length === 0 && !(typeof content === "string" && content.length > 0)) {
    return null;
  }

  const out: Record<string, unknown> = { role: "assistant" };
  if (texts.length > 0) {
    const parts = openaiContentParts(texts);
    out.content = parts.length === 1 ? parts[0].text : parts;
  } else if (typeof content === "string" && content.length > 0) {
    out.content = content;
  }

  // `cache_control` markers on content blocks are Anthropic-only prompt
  // caching hints: they are never copied onto the OpenAI message, so a
  // provider that errors on unknown fields never sees them. Likewise the
  // top-level `thinking` request parameter is dropped (see anthropicToOpenAI).
  // The thinking *blocks* are translated only when the target is known to
  // accept `reasoning_content`; otherwise they are stripped with them.
  if (options.reasoningContent === true) {
    const thinking = thinkingText(blocks);
    if (thinking.length > 0) out.reasoning_content = thinking;
  }

  if (toolUses.length > 0) {
    const toolCalls: Record<string, unknown>[] = [];
    for (const block of toolUses) {
      const b = block as Record<string, unknown>;
      let input = "";
      try {
        input = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {});
      } catch {
        input = "{}";
      }
      toolCalls.push({
        id: asString(b.id) ?? `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: { name: asString(b.name) ?? "", arguments: input },
      });
    }
    out.tool_calls = toolCalls;
  }
  return out;
}

/**
 * Translate an Anthropic Messages request into an OpenAI Chat Completions
 * request for `targetModel` (the provider's own model id).
 *
 * Anthropic-only request fields are stripped, never forwarded: `cache_control`
 * markers on system/content blocks and the top-level `thinking` parameter
 * (extended-thinking budget) have no OpenAI equivalent and would make
 * strict upstreams reject the request. `thinking` content blocks are
 * translated to `reasoning_content` only when
 * `options.reasoningContent` is true (see BridgeOptions); otherwise they
 * are stripped too, and a thinking-only assistant message is dropped
 * entirely rather than emitted as an empty assistant message.
 */
export function anthropicToOpenAI(
  body: unknown,
  targetModel: string,
  options: BridgeOptions = {},
): Record<string, unknown> {
  const normalized = options.vision === false ? stripAnthropicImages(body) : body;
  const root = isRecord(normalized) ? normalized : {};
  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new BridgeValidationError("messages must be a non-empty array.");
  }

  const messages: Record<string, unknown>[] = [];
  const system = root.system;

  if (system !== undefined) {
    messages.push({ role: "system", content: openaiUserContent(system) });
  }

  // Reasoning is only carried back for the CURRENT agentic turn: the
  // assistant messages after the last real user message (one that is not just
  // tool results). DeepSeek thinking mode needs reasoning_content echoed back
  // inside a tool-call loop but rejects or ignores it from earlier turns, and
  // older turns' chain-of-thought is wasted input on every provider.
  const turnStart = lastRealUserIndex(rawMessages);
  const pastTurnOptions: BridgeOptions = { ...options, reasoningContent: false };

  for (const [i, raw] of rawMessages.entries()) {
    const message = isRecord(raw) ? raw : {};
    const role = asString(message.role) ?? "user";
    if (role === "user") {
      const content = message.content;
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b) => isRecord(b) && (b as Record<string, unknown>).type === "tool_result",
        );
        const others = content.filter(
          (b) => !(isRecord(b) && (b as Record<string, unknown>).type === "tool_result"),
        );
        // OpenAI requires tool-result messages to follow the assistant message
        // that declared the tool_calls; emit them before the rest of the user
        // content so ordering stays valid.
        for (const block of toolResults) {
          const b = block as Record<string, unknown>;
          const toolCallId = asString(b.tool_use_id);
          if (!toolCallId) continue;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: openaiToolContent(b.content),
            // OpenAI chat has no standard error flag on tool messages.
            // Carry Anthropic's is_error as an extension field (servers
            // that don't know it ignore it) so the failure semantics
            // survive translation instead of being silently dropped.
            // Only emitted when true: the common case stays byte-identical.
            ...(b.is_error === true ? { is_error: true } : {}),
          });
        }
        if (others.length > 0) {
          messages.push({ role: "user", content: openaiUserContent(others) });
        }
      } else if (content !== undefined) {
        messages.push({ role: "user", content: openaiUserContent(content) });
      }
    } else if (role === "assistant") {
      // A thinking-only assistant message returns null and is dropped (see
      // anthropicAssistantMessage); everything else keeps its place so
      // tool_result ordering stays valid.
      const translated = anthropicAssistantMessage(message, i > turnStart ? options : pastTurnOptions);
      if (translated !== null) messages.push(translated);
    } else {
      messages.push({ role, content: message.content ?? "" });
    }
  }

  const out: Record<string, unknown> = {
    model: targetModel,
    messages,
  };
  const maxTokens = asNumber(root.max_tokens);
  if (maxTokens !== undefined) out.max_tokens = clampMaxTokens(maxTokens, options.maxOutputTokens);
  const temperature = asNumber(root.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = asNumber(root.top_p);
  if (topP !== undefined) out.top_p = topP;
  if (Array.isArray(root.stop_sequences) && root.stop_sequences.length > 0) {
    out.stop = root.stop_sequences;
  }
  const tools = anthropicToolsToOpenAI(root.tools);
  if (tools !== undefined) {
    out.tools = tools;
    // tool_choice is only meaningful alongside tools; without them there
    // is nothing to force, and strict upstreams reject a bare tool_choice.
    const { toolChoice, parallelToolCalls } = anthropicToolChoiceToOpenAI(root.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (parallelToolCalls !== undefined) out.parallel_tool_calls = parallelToolCalls;
  }
  if (root.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/**
 * Rewrite a tool name the upstream returned so it matches the name the client
 * declared, when the only difference is case. Some OpenAI-compatible servers
 * (e.g. Ollama) lowercase tool names (`read`, `bash`); Claude Code declared
 * `Read`, `Bash` and would not match the returned call, so the tool would be
 * silently dropped. Repair only on an unambiguous case-insensitive match;
 * otherwise leave the name untouched (a genuinely unknown tool is not ours to
 * rename).
 */
export function repairToolName(name: string, declaredToolNames?: ReadonlySet<string>): string {
  if (!declaredToolNames || declaredToolNames.size === 0 || name.length === 0) return name;
  if (declaredToolNames.has(name)) return name;
  const lower = name.toLowerCase();
  for (const candidate of declaredToolNames) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return name;
}

/** OpenAI tool_calls -> Anthropic tool_use content blocks. */
function openaiToolCallsToBlocks(
  toolCalls: unknown,
  declaredToolNames?: ReadonlySet<string>,
): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const raw of toolCalls) {
    const call = isRecord(raw) ? raw : {};
    const fn = isRecord(call.function) ? call.function : {};
    let input: unknown = {};
    try {
      input = JSON.parse(repairToolArguments(fn.arguments));
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: ensureToolCallId(call.id),
      name: repairToolName(asString(fn.name) ?? "", declaredToolNames),
      input,
    });
  }
  return blocks;
}

/**
 * Translate an OpenAI Chat Completions response into an Anthropic Messages
 * response.
 */
export function openAIToAnthropicResponse(
  body: unknown,
  requestedModel: string,
  declaredToolNames?: ReadonlySet<string>,
): Record<string, unknown> {
  const root = isRecord(body) ? body : {};
  if (root.error !== undefined) {
    throw new BridgeValidationError(`upstream provider error: ${JSON.stringify(root.error)}`);
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};

  const content: Record<string, unknown>[] = [];
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    if (rawContent.length > 0) content.push({ type: "text", text: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const part of rawContent) {
      const p = isRecord(part) ? part : {};
      const text = asString(p.text);
      if (text !== undefined) content.push({ type: "text", text });
      const url = isRecord(p.image_url) ? asString(p.image_url.url) : undefined;
      if (url !== undefined) content.push({ type: "text", text: url });
    }
  }
  // Reasoning models report their chain-of-thought as `reasoning_content`
  // (DeepSeek, Qwen, Grok, GLM, Moonshot) or `reasoning` (some gateways).
  // Map it back to an Anthropic `thinking` block ahead of the text so
  // Claude Code sees the reasoning and can send it back on the next turn,
  // closing the multi-turn tool loop. Absent or empty = no block.
  const reasoning = asString(message.reasoning_content) ?? asString(message.reasoning);
  if (reasoning !== undefined && reasoning.length > 0) {
    content.unshift({ type: "thinking", thinking: reasoning });
  }
  for (const block of openaiToolCallsToBlocks(message.tool_calls, declaredToolNames)) {
    content.push(block);
  }

  // Translate OpenAI usage counts to the Anthropic wire names, mapping cache
  // hits (prompt_tokens_details.cached_tokens) to cache_read_input_tokens.
  // Fields the provider did not report are omitted, never fabricated as 0.
  const usage = isRecord(root.usage) ? root.usage : {};
  const inputTokens = asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.completion_tokens);
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cachedTokens = asNumber(details.cached_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  const mappedUsage: Record<string, unknown> = {};
  if (inputTokens !== undefined) mappedUsage.input_tokens = inputTokens;
  if (outputTokens !== undefined) mappedUsage.output_tokens = outputTokens;
  if (cachedTokens !== undefined) mappedUsage.cache_read_input_tokens = cachedTokens;
  if (cacheCreation !== undefined) mappedUsage.cache_creation_input_tokens = cacheCreation;

  const stopReason = mapStopReason(first.finish_reason);

  return {
    id: `msg_${asString(root.id) ?? randomUUID()}`,
    type: "message",
    role: "assistant",
    model: asString(root.model) ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mappedUsage,
  };
}

/** Anthropic-style error body, close to the real API's shape. */
export function anthropicErrorBody(status: number, message: string): string {
  let type = "api_error";
  if (status === 400) type = "invalid_request_error";
  else if (status === 401) type = "authentication_error";
  else if (status === 403) type = "permission_error";
  else if (status === 404) type = "not_found_error";
  else if (status === 429) type = "rate_limit_error";
  return JSON.stringify({ type: "error", error: { type, message } });
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE chunks -> Anthropic SSE events.
// ---------------------------------------------------------------------------

export interface AnthropicSseEvent {
  /** Optional `event:` field (Anthropic names events). */
  event?: string;
  data: string;
}

function sseLine(event: AnthropicSseEvent): string {
  const out = [];
  if (event.event) out.push(`event: ${event.event}`);
  out.push(`data: ${event.data}`);
  return `${out.join("\n")}\n\n`;
}

/**
 * Build the initial message_start event. `usage` is the input-side usage
 * known at stream start (empty when the provider has not reported any yet —
 * OpenAI-style streams usually surface usage only in the final chunk).
 */
function messageStartEvent(id: string, model: string, usage: Record<string, unknown> = {}): AnthropicSseEvent {
  return {
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
  };
}

/**
 * Incremental translator from OpenAI SSE chunks to Anthropic SSE events.
 *
 * Usage: call `push(chunkJson)` for every OpenAI SSE `data:` frame (except
 * `[DONE]`), then `finish()` once the stream ends. Returns the Anthropic
 * event lines to relay. One instance per upstream stream.
 */
/** Max downstream silence while tool arguments are being buffered. */
const KEEPALIVE_MS = 10_000;

export class OpenAIStreamTranslator {
  private readonly id: string;
  private model = "";
  private started = false;
  private done = false;
  private blockIndex = -1;
  private textIndex = -1;
  /** OpenAI tool_call index -> stable per-block state. */
  private readonly toolBlocks = new Map<
    number,
    { id: string; name: string; blockIndex: number; args: string }
  >();
  /** Stable indices for id-less tool_calls that carry no `index` of their own. */
  private readonly toolIdIndex = new Map<string, number>();
  /** -1 is reserved for entirely anonymous deltas; real indices are >= 0. */
  private nextSyntheticToolIndex = -2;
  /** Anthropic content-block index of the thinking block, once opened. */
  private thinkingIndex = -1;
  /** True once the thinking block's content_block_stop has been emitted. */
  private thinkingClosed = false;
  /** Input/cache totals from upstream usage chunks; undefined until seen. */
  private inputTokens?: number;
  private cacheReadTokens?: number;
  private cacheCreationTokens?: number;
  private outputTokens = 0;
  /** True once the upstream reported completion_tokens at least once. */
  private sawOutputTokens = false;
  private pendingStop: string | null = null;
  /** Tool names the client declared, for case-repair of returned tool calls. */
  private readonly declaredToolNames?: ReadonlySet<string>;

  constructor(declaredToolNames?: ReadonlySet<string>) {
    this.id = `msg_${randomUUID()}`;
    this.declaredToolNames = declaredToolNames;
  }

  /** Wall clock of the last event handed downstream (keepalive pacing). */
  private lastEventAt = Date.now();

  /**
   * Feed one parsed OpenAI stream chunk. Returns Anthropic event lines.
   *
   * Tool arguments are buffered until their block closes, so a long tool
   * call (a big Write) can produce no content events for a while. When the
   * upstream is still sending but nothing has gone downstream for
   * {@link KEEPALIVE_MS}, emit an Anthropic `ping` so proxies and the SDK do
   * not treat the stream as idle.
   */
  push(chunk: unknown): AnthropicSseEvent[] {
    const lines = this.pushChunk(chunk);
    const now = Date.now();
    if (lines.length > 0) {
      this.lastEventAt = now;
    } else if (!this.done && this.started && now - this.lastEventAt >= KEEPALIVE_MS) {
      this.lastEventAt = now;
      lines.push({ event: "ping", data: JSON.stringify({ type: "ping" }) });
    }
    return lines;
  }

  private pushChunk(chunk: unknown): AnthropicSseEvent[] {
    if (this.done) return [];
    const root = isRecord(chunk) ? chunk : {};
    if (root.error !== undefined) {
      throw new Error(`upstream stream error: ${JSON.stringify(root.error)}`);
    }
    const lines: AnthropicSseEvent[] = [];

    // Capture usage before emitting message_start so a provider that includes
    // usage in its first chunk seeds the start event with real input tokens.
    const usage = isRecord(root.usage) ? root.usage : {};
    const promptTokens = asNumber(usage.prompt_tokens);
    const completionTokens = asNumber(usage.completion_tokens);
    if (promptTokens !== undefined) this.inputTokens = promptTokens;
    if (completionTokens !== undefined) {
      this.outputTokens = completionTokens;
      this.sawOutputTokens = true;
    }
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const cachedTokens = asNumber(details.cached_tokens);
    if (cachedTokens !== undefined) this.cacheReadTokens = cachedTokens;
    const cacheCreation = asNumber(usage.cache_creation_input_tokens);
    if (cacheCreation !== undefined) this.cacheCreationTokens = cacheCreation;

    if (!this.started) {
      this.model = asString(root.model) ?? "";
      const startUsage: Record<string, unknown> = {};
      if (this.inputTokens !== undefined) startUsage.input_tokens = this.inputTokens;
      if (this.cacheReadTokens !== undefined) startUsage.cache_read_input_tokens = this.cacheReadTokens;
      if (this.cacheCreationTokens !== undefined) startUsage.cache_creation_input_tokens = this.cacheCreationTokens;
      lines.push(messageStartEvent(this.id, this.model, startUsage));
      this.started = true;
    }

    // Some providers emit choices out of order, or pad them with nulls. The
    // primary choice is index 0; fall back to the first object-like entry.
    // An empty/absent choices array (usage-only chunk) yields an empty delta.
    const choices: Record<string, unknown>[] = Array.isArray(root.choices)
      ? root.choices.filter(isRecord)
      : [];
    const first = choices.find((choice) => asNumber(choice.index) === 0) ?? choices[0] ?? {};
    const delta = isRecord(first.delta) ? first.delta : {};

    // Reasoning models stream their chain-of-thought as `reasoning_content`
    // (DeepSeek, Qwen, Grok, GLM, Moonshot) or `reasoning` (some gateways).
    // Map it to an Anthropic `thinking` block with `thinking_delta` events
    // so Claude Code sees the reasoning. Anthropic requires thinking blocks
    // to precede every other content block: reasoning that arrives after
    // the text (or a tool) block started cannot be emitted as thinking and is
    // dropped.
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning);
    if (
      reasoning !== undefined &&
      reasoning.length > 0 &&
      this.textIndex === -1 &&
      !this.thinkingClosed &&
      this.toolBlocks.size === 0
    ) {
      if (this.thinkingIndex === -1) {
        this.blockIndex += 1;
        this.thinkingIndex = this.blockIndex;
        lines.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: this.thinkingIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
        });
      }
      lines.push({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: this.thinkingIndex,
          delta: { type: "thinking_delta", thinking: reasoning },
        }),
      });
    }

    const text = asString(delta.content);
    if (text !== undefined && text.length > 0) {
      // A thinking block must be closed before the text block starts:
      // Anthropic content blocks are sequential.
      this.closeThinking(lines);
      if (this.textIndex === -1) {
        this.blockIndex += 1;
        this.textIndex = this.blockIndex;
        lines.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          }),
        });
      }
      lines.push({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text },
        }),
      });
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of toolCalls) {
      const call = isRecord(raw) ? raw : {};
      // A missing `index` must map to one stable block: deriving it from the
      // moving blockIndex would split a single tool call across blocks. Use
      // the call id when present, otherwise one bucket for anonymous deltas.
      let oaiIndex = asNumber(call.index);
      if (oaiIndex === undefined) {
        const callId = asString(call.id);
        if (callId !== undefined && callId.length > 0) {
          const known = this.toolIdIndex.get(callId);
          if (known !== undefined) {
            oaiIndex = known;
          } else {
            oaiIndex = this.nextSyntheticToolIndex--;
            this.toolIdIndex.set(callId, oaiIndex);
          }
        } else {
          oaiIndex = -1;
        }
      }
      const fn = isRecord(call.function) ? call.function : {};
      const args = asString(fn.arguments);

      let block = this.toolBlocks.get(oaiIndex);
      if (!block) {
        // Close any open thinking/text block before starting a tool block:
        // Anthropic content blocks are sequential, thinking then text then
        // tool_use.
        this.closeThinking(lines);
        if (this.textIndex !== -1) {
          lines.push({
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
          });
          this.textIndex = -1;
        }
        this.blockIndex += 1;
        block = {
          // Providers that omit the id still need a non-empty one: the
          // Anthropic SDK keys tool_result blocks by it.
          id: ensureToolCallId(call.id),
          name: asString(fn.name) ?? "",
          blockIndex: this.blockIndex,
          args: "",
        };
        this.toolBlocks.set(oaiIndex, block);
        lines.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: block.blockIndex,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: repairToolName(block.name, this.declaredToolNames),
              input: {},
            },
          }),
        });
      }

      if (args !== undefined && args.length > 0) {
        // Buffer the raw fragments; the input is validated once, when the
        // block closes (see finalize). Relaying fragments as they arrive
        // would commit a prefix that might later have to be "completed" by
        // guessing — and a guessed command or file body must never run.
        block.args += args;
      }
    }

    const finishReason = asString(first.finish_reason);
    if (finishReason !== undefined && finishReason !== null && this.pendingStop === null) {
      this.pendingStop = mapStopReason(finishReason);
      // If usage already arrived (or the provider never sends a usage chunk),
      // finalize immediately; otherwise wait for the usage chunk.
      if (this.pendingStop !== null && (completionTokens !== undefined || promptTokens !== undefined)) {
        lines.push(...this.finalize());
      }
    }

    return lines;
  }

  /** Close the stream (call on [DONE] / EOF). Returns any final events. */
  finish(): AnthropicSseEvent[] {
    if (this.done) return [];
    return this.finalize();
  }

  /** Emit content_block_stop for the thinking block if it is still open. */
  private closeThinking(lines: AnthropicSseEvent[]): void {
    if (this.thinkingIndex !== -1 && !this.thinkingClosed) {
      this.thinkingClosed = true;
      lines.push({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: this.thinkingIndex }),
      });
    }
  }

  private finalize(): AnthropicSseEvent[] {
    const lines: AnthropicSseEvent[] = [];
    // Close blocks in content order: thinking first, then text, then tools.
    this.closeThinking(lines);
    if (this.textIndex !== -1) {
      lines.push({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
      });
      this.textIndex = -1;
    }
    // Close any open tool blocks in ascending content-block order. This is
    // also the last chance to make each tool's JSON input parseable: emit a
    // completion suffix for a truncated prefix, or `{}` when the provider's
    // fragments were wholly unusable.
    const openBlocks = Array.from(this.toolBlocks.values()).sort((a, b) => a.blockIndex - b.blockIndex);
    const notices: string[] = [];
    for (const block of openBlocks) {
      if (this.closedToolBlocks.has(block.blockIndex)) continue;
      this.closedToolBlocks.add(block.blockIndex);
      const normalized = normalizeToolArguments(block.args);
      if (normalized.problem) {
        notices.push(toolArgumentsNotice(block.name, block.id, normalized.problem));
      }
      if (block.args.length > 0) {
        lines.push({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: block.blockIndex,
            delta: { type: "input_json_delta", partial_json: normalized.json },
          }),
        });
      }
      lines.push({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: block.blockIndex }),
      });
    }
    // Tell the model, in-band, which calls were neutralized and why: the
    // tool itself only sees `{}` and fails input validation.
    if (notices.length > 0) {
      this.blockIndex += 1;
      const index = this.blockIndex;
      lines.push(
        {
          event: "content_block_start",
          data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: notices.join("\n") },
          }),
        },
        { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) },
      );
    }
    // Cumulative whole-message totals; only fields the upstream actually
    // reported are emitted. The Anthropic SDK overwrites message_start counts
    // with these when present, so input tokens surface even though OpenAI
    // streams typically report usage only at the very end. When the provider
    // reported nothing at all the usage object stays empty, so Claude never
    // sees fabricated zeros.
    const usage: Record<string, unknown> = {};
    if (this.sawOutputTokens) usage.output_tokens = this.outputTokens;
    if (this.inputTokens !== undefined) usage.input_tokens = this.inputTokens;
    if (this.cacheReadTokens !== undefined) usage.cache_read_input_tokens = this.cacheReadTokens;
    if (this.cacheCreationTokens !== undefined) usage.cache_creation_input_tokens = this.cacheCreationTokens;
    lines.push({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: this.pendingStop ?? "end_turn",
          stop_sequence: null,
        },
        usage,
      }),
    });
    lines.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
    this.done = true;
    return lines;
  }

  private readonly closedToolBlocks = new Set<number>();
}

// ---------------------------------------------------------------------------
// Token estimation for /v1/messages/count_tokens.
// ---------------------------------------------------------------------------

function estimateTokens(text: unknown): number {
  if (typeof text !== "string") return 0;
  // Rough heuristic: ~4 chars per token, matching typical BPE tokenizers.
  return Math.ceil(text.length / 4);
}

/** Estimate input tokens for an Anthropic Messages request. */
export function estimateInputTokens(body: unknown): number {
  const root = isRecord(body) ? body : {};
  let total = 0;

  const system = root.system;
  if (typeof system === "string") total += estimateTokens(system);
  else if (Array.isArray(system)) {
    for (const block of system) {
      total += estimateTokens(isRecord(block) ? block.text : "");
    }
  }

  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (const raw of messages) {
    const message = isRecord(raw) ? raw : {};
    total += 4; // role + framing overhead
    const content = message.content;
    if (typeof content === "string") {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = isRecord(block) ? block : {};
        if (b.type === "text") total += estimateTokens(b.text);
        else if (b.type === "image") total += 100; // fixed image approximation
        else if (b.type === "tool_result") {
          total += estimateTokens(b.content);
          total += estimateTokens(b.tool_use_id);
        } else if (b.type === "tool_use") {
          total += estimateTokens(b.id);
          total += estimateTokens(b.name);
          total += estimateTokens(JSON.stringify(b.input ?? {}));
        }
      }
    }
  }

  const tools = Array.isArray(root.tools) ? root.tools : [];
  for (const raw of tools) {
    const tool = isRecord(raw) ? raw : {};
    total += 6;
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(tool.input_schema === undefined ? "" : JSON.stringify(tool.input_schema));
    if (tool.type === "function" && isRecord(tool.function)) {
      const fn = tool.function;
      total += estimateTokens(fn.name);
      total += estimateTokens(fn.description);
      total += estimateTokens(fn.parameters === undefined ? "" : JSON.stringify(fn.parameters));
    }
  }

  return total;
}
