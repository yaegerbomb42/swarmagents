import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write";
import { resolveStorageDir } from "../board/store";
import type { BoardAgentConversation, BoardAgentMessage } from "./types";

function conversationFile(userId: string): string {
  // Auth IDs can contain email addresses. Hash IDs that aren't short, safe
  // path components, including mixed-case IDs on case-insensitive volumes.
  const fileId = /^[a-z0-9_@.+-]{1,180}$/.test(userId)
    ? userId
    : `~${createHash("sha256").update(userId).digest("hex")}`;
  return path.join(resolveStorageDir(), "board-agent", `conversations-${fileId}.json`);
}

function isMessage(value: unknown): value is BoardAgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const { role, content, createdAt, taskId, runId } = value as Partial<BoardAgentMessage>;
  return (role === "user" || role === "agent" || role === "tool") &&
    typeof content === "string" && Number.isFinite(createdAt) &&
    (taskId === undefined || typeof taskId === "string") &&
    (runId === undefined || typeof runId === "string");
}

function isOwnedConversation(value: unknown, userId: string): value is BoardAgentConversation {
  if (typeof value !== "object" || value === null) return false;
  const conv = value as Partial<BoardAgentConversation>;
  return conv.userId === userId && typeof conv.id === "string" && typeof conv.title === "string" &&
    Number.isFinite(conv.createdAt) && Number.isFinite(conv.updatedAt) &&
    Array.isArray(conv.messages) && conv.messages.every(isMessage);
}

function readConversations(file: string, userId: string): BoardAgentConversation[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A filesystem error isn't corruption; don't overwrite a file we couldn't read.
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((conv) => isOwnedConversation(conv, userId)) : [];
}

export function loadConversations(userId: string): BoardAgentConversation[] {
  return readConversations(conversationFile(userId), userId);
}

export function saveConversation(userId: string, conv: BoardAgentConversation): void {
  if (conv.userId !== userId) throw new Error("Conversation owner does not match caller.");
  const file = conversationFile(userId);
  // The read-modify-write is synchronous so separate conversations for the
  // same user can't lose each other's saves within this server process.
  const conversations = readConversations(file, userId);
  const index = conversations.findIndex((item) => item.id === conv.id);
  if (index === -1) conversations.push(conv);
  else conversations[index] = conv;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFile(file, JSON.stringify(conversations), { mode: 0o600 });
}

export function getConversation(userId: string, id: string): BoardAgentConversation | undefined {
  return loadConversations(userId).find((conv) => conv.id === id);
}

export function listConversations(userId: string): BoardAgentConversation[] {
  return loadConversations(userId).sort((a, b) => b.updatedAt - a.updatedAt);
}
