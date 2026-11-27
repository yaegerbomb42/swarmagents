"use client";

/**
 * HistoryPanel — every conversation, newest first, in a sheet on the left.
 *
 * Opening one swaps the chat to it; New chat starts an empty one. The
 * conversation holding the active run carries the same live status badge the
 * header shows, so a run is easy to find again after looking at older chats.
 */

import React, { useMemo, useState } from "react";
import { Clock, Search, SquarePen, X } from "lucide-react";
import { formatRelativeTime, type ThreadSummary } from "../../../lib/client/thread";
import type { UnreadScheduledRun } from "../../../lib/client/schedules";
import { cn } from "../utils/cn";
import { Button, Loading, Notice, Sheet, StatusBadge } from "./ui";
import { EmptyState } from "./brand/EmptyState";

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
  /** Unread completed scheduled runs to surface with a quick jump action. */
  unreadCronRuns?: readonly UnreadScheduledRun[];
  onJumpToCronRun?: (runId: string) => void;
  onMarkCronRunsRead?: () => void;
}

export function filterThreads(threads: readonly ThreadSummary[], query: string): ThreadSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...threads];
  return threads.filter((t) => {
    const title = (t.title || "Untitled chat").toLowerCase();
    return title.includes(q);
  });
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
  unreadCronRuns = [],
  onJumpToCronRun,
  onMarkCronRunsRead,
}: HistoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredThreads = useMemo(
    () => filterThreads(threads, searchQuery),
    [threads, searchQuery],
  );

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

        {unreadCronRuns.length > 0 && (
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/5 p-2.5" data-testid="unread-cron-runs">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                <Clock className="h-3 w-3" aria-hidden />
                Scheduled runs ({unreadCronRuns.length})
              </span>
              {onMarkCronRunsRead && (
                <button
                  type="button"
                  onClick={onMarkCronRunsRead}
                  data-testid="mark-cron-runs-read"
                  className="cursor-pointer text-[11px] text-sa-fg3 hover:text-sa-fg"
                >
                  Mark read
                </button>
              )}
            </div>
            <ul className="space-y-1">
              {unreadCronRuns.map((item) => (
                <li key={item.runId}>
                  <button
                    type="button"
                    onClick={() => {
                      onJumpToCronRun?.(item.runId);
                      onClose();
                    }}
                    data-testid={`unread-cron-run-${item.runId}`}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-sa-fg hover:bg-sa-hover"
                  >
                    <span className="min-w-0 truncate">{item.scheduleName}</span>
                    <span className="shrink-0 text-[11px] text-sa-fg3">{formatRelativeTime(item.ranAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state === "ready" && threads.length > 0 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sa-fg3" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              data-testid="history-search-input"
              className="w-full rounded-lg border border-sa-line-strong bg-sa-bg py-1.5 pl-8 pr-7 text-xs text-sa-fg outline-none placeholder:text-sa-fg3 focus:border-sa-accent"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                data-testid="history-search-clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-sa-fg3 hover:text-sa-fg"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

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
          <EmptyState
            testId="history-empty"
            icon="chat-bar"
            title="No conversations yet"
            description="Your chats with the agent are kept here."
          />
        )}

        {state === "ready" && threads.length > 0 && filteredThreads.length === 0 && (
          <EmptyState
            testId="history-no-results"
            icon="chat-bar"
            title="No conversations match"
            description={`Nothing matches \u201c${searchQuery}\u201d.`}
          />
        )}

        {state === "ready" && filteredThreads.length > 0 && (
          <ul className="space-y-0.5" data-testid="history-list">
            {filteredThreads.map((thread) => {
              const current = thread.id === currentId;
              const displayTitle = thread.title || "Untitled chat";
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(thread.id);
                      onClose();
                    }}
                    title={displayTitle}
                    aria-current={current ? "true" : undefined}
                    data-testid="history-thread"
                    className={cn(
                      "block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-sa-hover",
                      current && "bg-sa-hover",
                    )}
                  >
                    <span className="block truncate text-sm text-sa-fg">{displayTitle}</span>
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
