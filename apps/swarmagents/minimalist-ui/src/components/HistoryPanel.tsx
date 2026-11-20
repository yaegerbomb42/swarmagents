"use client";

/**
 * HistoryPanel — every conversation, newest first, in a sheet on the left.
 *
 * Opening one swaps the chat to it; New chat starts an empty one. The
 * conversation holding the active run carries the same live status badge the
 * header shows, so a run is easy to find again after looking at older chats.
 */

import React from "react";
import { SquarePen } from "lucide-react";
import { formatRelativeTime, type ThreadSummary } from "../../../lib/client/thread";
import { cn } from "../utils/cn";
import { Button, Loading, Notice, Sheet, StatusBadge } from "./ui";

export interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  threads: ThreadSummary[];
  state: "loading" | "ready" | "error";
  /** The open conversation ("" for a new chat). */
  currentId: string;
  /** The conversation the active run belongs to, when there is one. */
  activeId?: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onRetry: () => void;
}

export function HistoryPanel({
  open,
  onClose,
  threads,
  state,
  currentId,
  activeId,
  onSelect,
  onNewChat,
  newChatDisabled,
  onRetry,
}: HistoryPanelProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Conversations" side="left" widthClass="sm:max-w-[360px]" testId="history-panel">
      <div className="space-y-3 p-3">
        <Button
          className="w-full"
          onClick={() => {
            onNewChat();
            onClose();
          }}
          disabled={newChatDisabled}
          title={newChatDisabled ? "Stop the run to start a new chat" : undefined}
          data-testid="history-new-chat"
        >
          <SquarePen className="h-4 w-4" aria-hidden />
          New chat
        </Button>

        {state === "loading" && <Loading label="Loading conversations" className="py-8" />}

        {state === "error" && (
          <Notice
            tone="err"
            title="Conversations could not be loaded"
            action={
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          >
            Check your connection and try again.
          </Notice>
        )}

        {state === "ready" && threads.length === 0 && (
          <p className="px-1 py-8 text-center text-[13px] text-sa-fg2" data-testid="history-empty">
            No conversations yet. Your chats with the agent are kept here.
          </p>
        )}

        {threads.length > 0 && (
          <ul className="space-y-0.5" data-testid="history-list">
            {threads.map((thread) => {
              const current = thread.id === currentId;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(thread.id);
                      onClose();
                    }}
                    aria-current={current ? "true" : undefined}
                    data-testid="history-thread"
                    className={cn(
                      "block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-sa-hover",
                      current && "bg-sa-hover",
                    )}
                  >
                    <span className="block truncate text-sm text-sa-fg">{thread.title || "Untitled chat"}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-[12px] text-sa-fg3">
                      {thread.id === activeId && <StatusBadge tone="accent" label="Running" live className="text-[12px]" />}
                      <span>{formatRelativeTime(thread.updatedAt)}</span>
                      <span>
                        {thread.runCount} {thread.runCount === 1 ? "run" : "runs"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

export default HistoryPanel;
