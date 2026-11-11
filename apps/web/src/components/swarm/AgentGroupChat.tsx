'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Radio, Send, Users } from 'lucide-react';
import type { AgentSandbox } from '@/lib/sandboxTypes';
import { useAgentTelemetry } from '@/hooks/useAgentTelemetry';
import { authHeaders } from '@/lib/auth';

export type GroupChatMessage = {
  id: string;
  agentId: string;
  label: string;
  model?: string;
  text: string;
  kind: 'thought' | 'communicate' | 'system' | 'user' | 'reply';
  ts: number;
};

type ChatTarget = { type: 'all' } | { type: 'agent'; agentId: string; label: string };

function extractMessages(sandboxes: AgentSandbox[]): GroupChatMessage[] {
  const out: GroupChatMessage[] = [];

  for (const sb of sandboxes) {
    const label = sb.label || sb.agentId;
    const model = sb.model;
    for (const t of sb.thoughtStream ?? []) {
      if (!t.text?.trim()) continue;
      out.push({
        id: `thought-${sb.agentId}-${t.ts}`,
        agentId: sb.agentId,
        label,
        model,
        text: t.text.trim(),
        kind: 'thought',
        ts: t.ts,
      });
    }
    for (const action of sb.actionLog ?? []) {
      if (action.type !== 'communicate') continue;
      const msg = action.label?.trim() || action.params?.find((p) => p.key === 'message')?.value;
      if (!msg) continue;
      out.push({
        id: `comm-${action.id}`,
        agentId: sb.agentId,
        label,
        model,
        text: msg,
        kind: 'communicate',
        ts: action.ts,
      });
    }
  }

  return out.sort((a, b) => a.ts - b.ts).slice(-80);
}

function workingAgents(sandboxes: AgentSandbox[]): AgentSandbox[] {
  const now = Date.now();
  return sandboxes.filter((sb) => {
    if (sb.status === 'running') return true;
    const lastThought = sb.thoughtStream?.[sb.thoughtStream.length - 1];
    const lastAction = sb.actionLog?.[sb.actionLog.length - 1];
    const lastTs = Math.max(lastThought?.ts ?? 0, lastAction?.ts ?? 0);
    return sb.status === 'idle' && lastTs > 0 && now - lastTs < 12_000;
  });
}

function avatarColor(agentId: string): string {
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) h = (h * 31 + agentId.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 55%)`;
}

export type AgentGroupChatProps = {
  sessionId?: string | null;
  projectId?: string | null;
  className?: string;
};

export default function AgentGroupChat({
  sessionId,
  projectId,
  className = '',
}: AgentGroupChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { sandboxes, connected } = useAgentTelemetry({
    sessionId: sessionId ?? undefined,
    enabled: Boolean(sessionId),
    pollFallbackMs: 2000,
  });

  const [localMessages, setLocalMessages] = useState<GroupChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [target, setTarget] = useState<ChatTarget>({ type: 'all' });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const sandboxMessages = useMemo(() => extractMessages(sandboxes), [sandboxes]);
  const active = useMemo(() => workingAgents(sandboxes), [sandboxes]);
  const messages = useMemo(
    () => [...sandboxMessages, ...localMessages].sort((a, b) => a.ts - b.ts).slice(-120),
    [sandboxMessages, localMessages]
  );
  const typing = useMemo(
    () =>
      active
        .filter((sb) => {
          const lastThought = sb.thoughtStream?.[sb.thoughtStream.length - 1];
          const lastAction = sb.actionLog?.[sb.actionLog.length - 1];
          const lastTs = Math.max(lastThought?.ts ?? 0, lastAction?.ts ?? 0);
          return lastTs > 0 && Date.now() - lastTs < 12_000;
        })
        .map((sb) => sb.label || sb.agentId),
    [active]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, typing.length]);

  const pushLocal = useCallback((m: GroupChatMessage) => {
    setLocalMessages((prev) => [...prev, m]);
  }, []);

  const handleSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || isSending) return;
    if (!sessionId && !projectId) return;

    setChatInput('');
    setIsSending(true);
    pushLocal({
      id: `user-${Date.now()}`,
      agentId: 'user',
      label: target.type === 'agent' ? `You → ${target.label}` : 'You → All agents',
      text,
      kind: 'user',
      ts: Date.now(),
    });

    try {
      const res = await fetch('/api/tasks/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          message: text,
          sessionId: sessionId || undefined,
          project_id: projectId || undefined,
          agentId: target.type === 'agent' ? target.agentId : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      const reply: string =
        (data && (data.response || data.message)) ||
        (!res.ok ? 'Could not reach the agents just now — try again.' : 'Message relayed.');
      pushLocal({
        id: `reply-${Date.now()}`,
        agentId: target.type === 'agent' ? target.agentId : 'collective',
        label: target.type === 'agent' ? target.label : data?.response ? 'Team' : 'Relay',
        text: String(reply),
        kind: 'reply',
        ts: Date.now() + 1,
      });
    } catch {
      pushLocal({
        id: `err-${Date.now()}`,
        agentId: 'system',
        label: 'System',
        text: 'Network error — message not delivered.',
        kind: 'system',
        ts: Date.now() + 1,
      });
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }, [chatInput, isSending, sessionId, projectId, target, pushLocal]);

  return (
    <div
      className={`flex flex-col h-full min-h-0 rounded-xl border border-white/10 overflow-hidden ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.78)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
        <MessageCircle className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[11px] font-medium text-zinc-200">Agent Groupchat</span>
        <span
          className={`inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded ${
            connected ? 'text-emerald-300 bg-emerald-500/10' : 'text-zinc-500 bg-white/[0.04]'
          }`}
        >
          <Radio className="w-2.5 h-2.5" />
          {connected ? 'live' : 'polling'}
        </span>
        <span className="ml-auto text-[9px] text-zinc-600 font-mono">{sandboxes.length} agents</span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-center text-[11px] text-zinc-500 py-8">
            {sessionId
              ? 'Waiting for agent thoughts and inter-agent messages…'
              : 'Start a decomp session to see live groupchat.'}
          </p>
        )}
        {messages.map((m) => {
          const isUser = m.kind === 'user';
          const isReply = m.kind === 'reply';
          return (
            <div
              key={m.id}
              className="flex gap-2 animate-in fade-in duration-150"
              style={{ transition: 'transform 80ms ease-out' }}
            >
              <div
                className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shadow-[0_0_12px_rgba(34,211,238,0.25)] ${
                  isUser ? 'bg-zinc-200 text-zinc-950' : 'text-white'
                }`}
                style={!isUser ? { background: avatarColor(m.agentId) } : undefined}
                aria-hidden
              >
                {isUser ? 'Y' : m.label.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-semibold truncate ${
                      isUser ? 'text-zinc-200' : isReply ? 'text-emerald-200/90' : 'text-cyan-200/90'
                    }`}
                  >
                    {m.label}
                  </span>
                  {m.model && (
                    <span className="text-[8px] font-mono text-violet-300/80 bg-violet-500/10 px-1 rounded truncate max-w-[8rem]">
                      {m.model}
                    </span>
                  )}
                  <span className="text-[8px] text-zinc-600 font-mono shrink-0">
                    {m.kind === 'communicate'
                      ? 'msg'
                      : m.kind === 'user'
                        ? 'you'
                        : m.kind === 'reply'
                          ? 'reply'
                          : 'think'}
                  </span>
                </div>
                <p
                  className={`mt-0.5 text-[11px] leading-relaxed rounded-lg px-2.5 py-1.5 border ${
                    isUser
                      ? 'bg-zinc-100 border-zinc-300 text-zinc-900'
                      : isReply
                        ? 'bg-emerald-500/8 border-emerald-400/15 text-emerald-50'
                        : m.kind === 'communicate'
                          ? 'bg-cyan-500/8 border-cyan-400/15 text-cyan-50'
                          : 'bg-white/[0.03] border-white/[0.05] text-zinc-300'
                  }`}
                >
                  {m.text}
                </p>
              </div>
            </div>
          );
        })}
        {typing.length > 0 && (
          <p className="text-[10px] text-zinc-500 font-mono animate-pulse px-1">
            {typing.join(', ')} typing…
          </p>
        )}
      </div>

      {/* Composer — talk to any agent or all of them */}
      <div className="border-t border-white/[0.06] shrink-0 p-2.5 space-y-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setTarget({ type: 'all' })}
            className={`inline-flex items-center gap-1 text-[9.5px] font-mono px-2 py-1 rounded-md border transition ${
              target.type === 'all'
                ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                : 'border-white/[0.08] text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <Users size={10} />
            All agents
          </button>
          {active.slice(0, 6).map((sb) => {
            const label = sb.label || sb.agentId;
            const selected = target.type === 'agent' && target.agentId === sb.agentId;
            return (
              <button
                key={sb.agentId}
                type="button"
                onClick={() => setTarget({ type: 'agent', agentId: sb.agentId, label })}
                className={`inline-flex items-center gap-1.5 text-[9.5px] font-mono px-2 py-1 rounded-md border transition max-w-[10rem] ${
                  selected
                    ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                    : 'border-white/[0.08] text-zinc-500 hover:text-zinc-300'
                }`}
                title={sb.status === 'running' ? `${label} — working` : label}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: avatarColor(sb.agentId) }}
                  aria-hidden
                />
                <span className="truncate">{label}</span>
                {sb.status === 'running' && (
                  <span
                    className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse shrink-0"
                    aria-label="working"
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-end gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] focus-within:border-cyan-400/30 px-2.5 py-1.5">
          <textarea
            ref={inputRef}
            rows={1}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={target.type === 'agent' ? `Message ${target.label}…` : 'Message all agents…'}
            className="flex-1 bg-transparent text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none max-h-24 py-1 leading-relaxed"
            disabled={isSending}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isSending || !chatInput.trim() || (!sessionId && !projectId)}
            className="shrink-0 w-7 h-7 rounded-md bg-cyan-500/20 border border-cyan-400/30 text-cyan-200 flex items-center justify-center disabled:opacity-25 hover:bg-cyan-500/30 transition-colors"
            aria-label="Send message to agents"
            title={!sessionId && !projectId ? 'Start an objective first' : 'Send'}
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
