"use client";

/**
 * Composer — the one place the user talks to the agent.
 *
 * A multiline box that grows with what is typed. Enter sends, Shift+Enter adds
 * a line. Files attach from the paperclip, a paste or a drop. Sending clears
 * the box at once (the message appears in the conversation); if the send
 * fails, the text and files come back with the reason, so nothing is lost.
 *
 * The box stays usable while a run is going: a message sent then is queued
 * and runs next. Stopping a run is the run indicator's job, not this box's.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Loader2, Paperclip, X } from "lucide-react";
import type { Attachment } from "../data";
import { uid } from "../data";
import type { RunTier } from "../../../lib/client/runs";
import { validateAttachment } from "../../../lib/client/upload";
import { cn } from "../utils/cn";
import { Button, IconButton, Notice } from "./ui";

export type ComposerSendResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

export interface ComposerProps {
  /** The draft. The workspace owns it so it survives view changes and reloads. */
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, attachments: Attachment[]) => Promise<ComposerSendResult>;
  /** A run is active, so a message sent now is queued behind it. */
  busy?: boolean;
  /** When set, sending is off and this says why (e.g. signed out). */
  blockedReason?: string;
  /** The roomier first-message variant used before a conversation exists. */
  hero?: boolean;
  /** Selected routing tier ("fast" | "balanced" | "deep"). */
  tier?: RunTier;
  onTierChange?: (tier: RunTier) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

const TIER_OPTIONS: Array<{ id: RunTier; label: string; title: string }> = [
  { id: "fast", label: "Fast", title: "Prefer fast / free models" },
  { id: "balanced", label: "Balanced", title: "Default balanced routing" },
  { id: "deep", label: "Deep", title: "Prefer reasoning / vision models" },
];

/** What a key press in the box means. IME composition never sends. */
export function composerKeyAction(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): "send" | "newline" | null {
  if (event.key !== "Enter") return null;
  if (event.isComposing) return null;
  return event.shiftKey ? "newline" : "send";
}

/** A message can go out when it has text or a file, and nothing is in flight. */
export function canSend(input: { text: string; attachments: number; sending: boolean; blocked?: boolean }): boolean {
  if (input.sending || input.blocked) return false;
  return input.text.trim().length > 0 || input.attachments > 0;
}

/**
 * Send a draft. The box empties at once, because the message is already
 * showing in the conversation; a refusal gives the text and the files back
 * with the reason. Kept outside the component so it is tested without a DOM.
 * Resolves true when the message went out.
 */
export async function sendDraft<F>(
  draft: { text: string; files: F[] },
  io: {
    onSend: (text: string, files: F[]) => Promise<ComposerSendResult>;
    setText: (text: string) => void;
    setFiles: (files: F[]) => void;
    setError: (error: string | undefined) => void;
    setSending: (sending: boolean) => void;
  },
): Promise<boolean> {
  io.setSending(true);
  io.setError(undefined);
  io.setText("");
  io.setFiles([]);
  let result: ComposerSendResult;
  try {
    result = await io.onSend(draft.text, draft.files);
  } catch (err) {
    result = { ok: false, error: err instanceof Error && err.message ? err.message : "Something went wrong." };
  }
  io.setSending(false);
  if (!result.ok) {
    io.setText(draft.text);
    io.setFiles(draft.files);
    io.setError(result.error);
  }
  return result.ok;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindOf(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("text/")) return "text";
  return "file";
}

function toAttachment(file: File): Attachment {
  const kind = kindOf(file);
  return {
    id: uid(),
    name: file.name || "pasted-file",
    size: file.size,
    type: file.type,
    kind,
    // Only images get a preview; other files never need an object URL.
    url: kind === "image" ? URL.createObjectURL(file) : "",
    file,
  };
}

function release(attachments: readonly Attachment[]): void {
  for (const attachment of attachments) {
    if (attachment.url) URL.revokeObjectURL(attachment.url);
  }
}

const MAX_HEIGHT_PX = 220;

export function Composer({
  value: draft,
  onChange: setDraft,
  onSend,
  busy = false,
  blockedReason,
  hero = false,
  tier = "balanced",
  onTierChange,
  inputRef,
  className,
}: ComposerProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // A failed send that is worth trying again (429/503, or the network): the
  // draft comes back, so Retry resends exactly what failed. A 401 is not
  // retryable — the workspace shows the sign-in notice instead.
  const [retryable, setRetryable] = useState(false);
  const lastSendStatusRef = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = inputRef ?? ownRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Grow with the text, up to a cap; past it the box scrolls.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft, textRef, hero]);

  // Object URLs for previews are released when the composer goes away.
  useEffect(() => () => release(attachmentsRef.current), []);

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const next = [...attachmentsRef.current];
    let problem: string | undefined;
    for (const file of files) {
      const invalid = validateAttachment(file, next.length);
      if (invalid) {
        problem = invalid;
        continue;
      }
      next.push(toAttachment(file));
    }
    attachmentsRef.current = next;
    setAttachments(next);
    setError(problem);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const current = attachmentsRef.current;
    release(current.filter((attachment) => attachment.id === id));
    const next = current.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
    setError(undefined);
  }, []);

  const blocked = Boolean(blockedReason);
  const sendable = canSend({ text: draft, attachments: attachments.length, sending, blocked });

  // Remember the last send's HTTP status so the error notice knows whether
  // a Retry button makes sense; sendDraft itself only reports success.
  const sendCapturing = useCallback(
    async (text: string, files: Attachment[]): Promise<ComposerSendResult> => {
      const result = await onSend(text, files);
      lastSendStatusRef.current = result.ok ? undefined : result.status;
      return result;
    },
    [onSend],
  );

  const submit = useCallback(async () => {
    if (!canSend({ text: draft, attachments: attachments.length, sending, blocked })) return;
    const files = attachments;
    setRetryable(false);
    const sent = await sendDraft(
      { text: draft, files },
      {
        onSend: sendCapturing,
        setText: setDraft,
        setFiles: (next) => {
          attachmentsRef.current = next;
          setAttachments(next);
        },
        setError,
        setSending,
      },
    );
    if (!sent) setRetryable(lastSendStatusRef.current !== 401);
    if (sent) release(files);
    textRef.current?.focus();
  }, [draft, attachments, sending, blocked, sendCapturing, setDraft, textRef]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (action !== "send") return;
    event.preventDefault();
    void submit();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  const placeholder = blockedReason
    ? blockedReason
    : sending
      ? "Sending…"
      : busy
        ? "Add a follow-up. It runs when the current run finishes."
        : hero
          ? "Describe the task. The agent has its own computer."
          : "Message the agent";

  return (
    <div className={cn("w-full", className)} data-testid="composer">
      {error && (
        <Notice
          tone="err"
          title="That did not send"
          className="sa-enter mb-2"
          testId="composer-error"
          action={
            retryable ? (
              <Button size="sm" onClick={() => void submit()} data-testid="composer-retry">
                Retry
              </Button>
            ) : undefined
          }
        >
          {error}
        </Notice>
      )}
      <div
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="composer-drop-zone"
          className={cn(
            "glass-2 composer-ring rounded-[22px] border border-white/[0.12] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_20px_50px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] focus-within:border-white/25 focus-within:ring-1 focus-within:ring-white/10",
            dragging ? "border-sky-300/50 ring-2 ring-sky-300/25 shadow-[0_0_24px_rgba(56,189,248,0.25)]" : "",
            hero && "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.16),0_24px_64px_-18px_rgba(0,0,0,0.9)]",
          )}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached files" data-testid="composer-attachments">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                data-testid="attachment-chip"
                className="flex max-w-full items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.06] py-1 pl-1 pr-1.5 backdrop-blur-xl"
              >
                {attachment.kind === "image" && attachment.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attachment.url} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
                ) : (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sa-hover text-sa-fg2">
                    <FileText className="h-4 w-4" aria-hidden />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block max-w-[180px] truncate text-[13px] text-sa-fg">{attachment.name}</span>
                  <span className="block text-[12px] text-sa-fg3">{formatFileSize(attachment.size)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-sa-fg3 transition-colors hover:bg-sa-hover hover:text-sa-fg"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* The action row carries a little extra bottom padding below sm so
            the bottom-left Attach button never sits flush to the glass edge
            (and to anything anchored to the viewport bottom) on a phone. */}
        <div className="flex items-end gap-1 px-1.5 pb-2 pt-1.5 sm:p-1.5" data-testid="composer-actions">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            data-testid="attachment-input"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <IconButton
            label="Attach files"
            data-testid="attach-button"
            disabled={blocked || sending}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" aria-hidden />
          </IconButton>
          <div className="relative flex-1">
            <textarea
              ref={textRef}
              data-testid="composer-input"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) {
                  setError(undefined);
                  setRetryable(false);
                }
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={hero ? 2 : 1}
              readOnly={sending}
              disabled={blocked}
              aria-label="Message the agent"
              aria-busy={sending || undefined}
              placeholder={placeholder}
              enterKeyHint="send"
              className="sa-scroll sa-framed-field block min-h-9 w-full resize-none bg-transparent px-1.5 py-2 text-base leading-5 text-sa-fg placeholder:text-sa-fg3 disabled:cursor-not-allowed sm:text-sm"
            />
            {draft.length === 0 && !busy && !blocked && (
              <span
                aria-hidden
                className="pointer-events-none hidden sm:inline-flex items-center gap-[3px] absolute right-2 top-2 font-mono text-[10.5px] text-white/30"
              >
                <kbd className="rounded-[4px] border border-white/[0.1] bg-white/[0.04] px-1 py-[1px]">⌘</kbd>
                <kbd className="rounded-[4px] border border-white/[0.1] bg-white/[0.04] px-1 py-[1px]">↵</kbd>
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid="composer-send"
            onClick={() => void submit()}
            disabled={!sendable}
            aria-label={busy ? "Queue message" : "Send message"}
            title={busy ? "Queue message (Enter)" : "Send (Enter)"}
            className="press grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--brand-signal)] text-[var(--brand-text-on-signal)] transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-[var(--mute)] disabled:hover:scale-100"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ArrowUp className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
        <p className="hidden text-[12px] text-sa-fg3 sm:block">
          Enter to send · Shift+Enter for a new line
        </p>
        {onTierChange && (
          <div
            role="group"
            aria-label="Model tier"
            data-testid="composer-tier-selector"
            className="inline-flex items-center rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5 text-[11px]"
          >
            {TIER_OPTIONS.map((option) => {
              const active = tier === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  title={option.title}
                  aria-pressed={active}
                  data-testid={`composer-tier-${option.id}`}
                  onClick={() => onTierChange(option.id)}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-0.5 font-medium transition-colors",
                    active
                      ? "bg-white/[0.12] text-sa-fg"
                      : "text-sa-fg3 hover:text-sa-fg2",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default Composer;
