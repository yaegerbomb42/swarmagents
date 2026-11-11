'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, MessageSquare } from 'lucide-react';
import {
  ConversationTurn,
  fetchConversationHistory,
  sendConversationTurn,
} from '@/lib/chatApi';

export interface AgentChatProps {
  projectId: string | null;
  runId?: string | null;
  /** Poll for fresh turns while true (active run). */
  active?: boolean;
  className?: string;
}

const POLL_MS = 2000;

export default function AgentChat({
  projectId,
  runId = null,
  active = false,
  className = '',
}: AgentChatProps) {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await fetchConversationHistory({
        projectId: projectId || undefined,
        limit: 50,
      });
      setTurns(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat unavailable');
    }
  }, [projectId]);

  // Initial load + poll while a run is active.
  useEffect(() => {
    void refresh();
    if (!active) return;
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [refresh, active]);

  // Keep the latest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendConversationTurn({
        content,
        projectId: projectId || undefined,
        runId: runId || undefined,
      });
      setDraft('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }, [draft, sending, projectId, runId, refresh]);

  return (
    <aside
      className={`flex flex-col w-96 border-l border-zinc-800 bg-zinc-950 ${className}`}
      aria-label="Agent chat"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <MessageSquare className="w-4 h-4 text-cyan-400" />
        <h2 className="text-sm font-semibold text-zinc-100">Agent Chat</h2>
        {active && (
          <span className="ml-auto flex items-center text-[10px] font-mono text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1.5" />
            LIVE
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {turns.length === 0 && (
          <p className="text-xs text-zinc-500 text-center mt-8">
            No turns yet — talk to the swarm mid-run.
          </p>
        )}
        {turns.map((t) => {
          const isAssistant = t.role === 'assistant' || t.role === 'system';
          return (
            <div key={t.id} className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  isAssistant
                    ? 'bg-zinc-900 text-cyan-300 border border-cyan-900/40'
                    : 'bg-zinc-800 text-white'
                }`}
              >
                {t.content}
                {t.created_at && (
                  <div className="mt-1 text-[9px] font-mono text-zinc-500">
                    {isAssistant ? (t.model || 'agent') : 'you'} ·{' '}
                    {new Date(t.created_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-rose-400 border-t border-rose-900/40">
          {error}
        </div>
      )}

      <div className="p-3 border-t border-zinc-800 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Message the swarm…"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-600"
          aria-label="Chat message"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || !draft.trim()}
          className="p-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Send message"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
