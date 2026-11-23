import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { runBoardAgent } from "@/lib/board-agent/agent";
import { boardAgentLogRedactor } from "@/lib/board-agent/redact";
import { getConversation, listConversations, saveConversation } from "@/lib/board-agent/store";
import type { BoardAgentConversation } from "@/lib/board-agent/types";
import { JsonBodyError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const STORAGE_ERROR = "Conversation storage is temporarily unavailable. Try again shortly.";
// Prevent two turns from continuing the same stale transcript in this process.
const activeTurns = new Set<string>();

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE, status });
}

function validConversationId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

async function readChatBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new JsonBodyError("Request body is too large.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new JsonBodyError("Invalid JSON body.", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new JsonBodyError("Request body is too large.", 413);
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof JsonBodyError) throw err;
    throw new JsonBodyError("Invalid JSON body.", 400);
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Middleware clears any client-supplied value and sets the authenticated id.
  const userId = request.headers.get(USER_HEADER);
  if (!userId) return json({ error: "Sign in required." }, 401);

  let body: unknown;
  try {
    body = await readChatBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) return json({ error: err.message }, err.status);
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object." }, 400);
  }
  const { message, conversationId } = body as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    return json({ error: `message must contain 1–${MAX_MESSAGE_LENGTH} characters.` }, 400);
  }
  if (conversationId !== undefined && !validConversationId(conversationId)) {
    return json({ error: "Invalid conversationId." }, 400);
  }

  const id = conversationId ?? randomUUID();
  const turnKey = JSON.stringify([userId, id]);
  if (activeTurns.has(turnKey)) return json({ error: "A turn is already in progress for this conversation." }, 409);
  activeTurns.add(turnKey);
  try {
    const now = Date.now();
    let conversation: BoardAgentConversation | undefined;
    try {
      conversation = conversationId === undefined
        ? { id, userId, title: message.trim().replace(/\s+/g, " ").slice(0, 80), messages: [], createdAt: now, updatedAt: now }
        : getConversation(userId, id);
    } catch {
      return json({ error: STORAGE_ERROR }, 503);
    }
    if (!conversation) return json({ error: "Conversation not found." }, 404);

    let result: Awaited<ReturnType<typeof runBoardAgent>>;
    try {
      result = await runBoardAgent(userId, conversation, message, { signal: request.signal });
    } catch (err) {
      const isAbort = Boolean(request.signal?.aborted) ||
        (err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("aborted")));
      if (isAbort) {
        return json({ error: "Request aborted." }, 499);
      }
      const redact = boardAgentLogRedactor(userId);
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error("[board-agent] turn execution failed:", redact(msg));
      return json({ error: "Board agent encountered an error processing your request." }, 500);
    }

    const { reply, taskIds, runIds, providerStatus } = result;
    try {
      saveConversation(userId, conversation);
    } catch {
      return json({ error: STORAGE_ERROR }, 503);
    }

    return json({ reply, conversationId: id, taskIds, runIds }, providerStatus);
  } finally {
    activeTurns.delete(turnKey);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const userId = request.headers.get(USER_HEADER);
  if (!userId) return json({ error: "Sign in required." }, 401);

  const id = new URL(request.url).searchParams.get("conversationId");
  try {
    if (id !== null) {
      if (!validConversationId(id)) return json({ error: "Invalid conversationId." }, 400);
      const conversation = getConversation(userId, id);
      return conversation ? json({ conversation }) : json({ error: "Conversation not found." }, 404);
    }
    const conversations = listConversations(userId).map(({ id, title, updatedAt, messages }) => ({
      id, title, updatedAt, messageCount: messages.length,
    }));
    return json({ conversations });
  } catch {
    return json({ error: STORAGE_ERROR }, 503);
  }
}
