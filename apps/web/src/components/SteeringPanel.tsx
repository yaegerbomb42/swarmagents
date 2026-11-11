'use client';

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, type Ref } from 'react';
import { ArrowUp, MessageSquare, RefreshCw, AlertCircle, Users, Bot } from 'lucide-react';
import type { SteerAction, SteerStatus } from '@/lib/decompSessions';

export interface SteerChatMessage {
  sender: 'user' | 'agent';
  from?: string;
  text: string;
  time: string;
  status?: SteerStatus;
  action?: SteerAction;
  affectedNodeIds?: string[];
}

interface SteeringPanelProps {
  sessionId?: string | null;
  projectId?: string | null;
  selectedNodeId?: string | null;
  paused?: boolean;
  messages: SteerChatMessage[];
  onMessages: (updater: (prev: SteerChatMessage[]) => SteerChatMessage[]) => void;
  onSessionUpdate?: (session: any) => void;
  className?: string;
  /**
   * When provided, the panel renders no internal input; the unified command
   * bar owns text entry and calls this to relay a steering message.
   */
  sendViaParent?: (text: string) => void;
  /** True while the parent-owned send is in flight (disables suggestions). */
  steerBusy?: boolean;
  /** Mirror of the internal input text (only used when no sendViaParent relay). */
  onInputValueChange?: (text: string) => void;
}

type ChatTarget = 'collective' | 'orchestrator';

const STATUS_LABEL: Record<SteerStatus, string> = {
  applied: 'Applied',
  partial: 'Partial',
  queued: 'Queued',
  rejected: 'Failed',
};

const STATUS_COLOR: Record<SteerStatus, string> = {
  applied: 'text-emerald-400/90 bg-emerald-500/10',
  partial: 'text-amber-400/90 bg-amber-500/10',
  queued: 'text-zinc-400 bg-white/5',
  rejected: 'text-rose-400/90 bg-rose-500/10',
};

const SUGGESTIONS = [
  'Pause the team',
  'Resume work',
  'Prefer TypeScript',
  "Don't touch auth",
  'Stricter quality bar',
];

function Avatar({ label, user }: { label: string; user?: boolean }) {
  const initials = label
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
        user
          ? 'bg-zinc-200 text-zinc-950'
          : 'bg-zinc-800 border border-zinc-700 text-zinc-300'
      }`}
      title={label}
    >
      {user ? initials || 'Y' : label.startsWith('Orch') ? <Bot size={12} /> : initials || <Users size={12} />}
    </div>
  );
}

export default function SteeringPanel({
  sessionId,
  projectId,
  selectedNodeId,
  paused = false,
  messages,
  onMessages,
  onSessionUpdate,
  className = '',
  sendViaParent,
  steerBusy = false,
  onInputValueChange,
}: SteeringPanelProps) {
  const [chatInput, setChatInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  const [target, setTarget] = useState<ChatTarget>('collective');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Mirror internal input upward so a parent-mounted unified command bar can
  // share the same draft text.
  const [mirroredInput, setMirroredInput] = useState('');
  useEffect(() => {
    if (onInputValueChange && chatInput !== mirroredInput) {
      setMirroredInput(chatInput);
      onInputValueChange(chatInput);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatInput]);

  const busy = sendViaParent ? steerBusy : isSending;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const pushAgent = useCallback(
    (text: string, extra?: Partial<SteerChatMessage>) => {
      onMessages((prev) => [
        ...prev,
        {
          sender: 'agent',
          from: extra?.from || (target === 'orchestrator' ? 'Orchestrator' : 'Collective'),
          text,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          ...extra,
        },
      ]);
    },
    [onMessages, target]
  );

  const sendSteer = useCallback(
    async (opts: {
      action?: SteerAction;
      message?: string;
      nodeId?: string;
      parentId?: string;
      payload?: Record<string, unknown>;
    }) => {
      setIsSending(true);
      try {
        const res = await fetch('/api/tasks/steer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...opts,
            sessionId: sessionId || undefined,
            project_id: projectId || sessionId || undefined,
            payload: {
              ...(opts.payload || {}),
              audience: target,
            },
          }),
        });
        const data = await res.json();

        if (
          data.ok &&
          opts.action === 're_decompose' &&
          (opts.nodeId || selectedNodeId) &&
          (sessionId || data.session?.id)
        ) {
          const sid = sessionId || data.session?.id;
          const nid = opts.nodeId || selectedNodeId!;
          const deepenRes = await fetch('/api/tasks/decompose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'deepen', sessionId: sid, nodeId: nid }),
          });
          if (deepenRes.ok) {
            const deepenData = await deepenRes.json();
            if (deepenData.session) onSessionUpdate?.(deepenData.session);
            pushAgent(
              data.response ||
                `Got it — broke that into ${deepenData.children?.length || 0} smaller tasks.`,
              {
                status: 'applied',
                action: 're_decompose',
                affectedNodeIds: data.affectedNodeIds,
                from: 'Orchestrator',
              }
            );
            return data;
          }
        }

        if (data.session) onSessionUpdate?.(data.session);

        pushAgent(data.response || data.error || "Couldn't reach the team just now.", {
          status: data.status || (data.ok ? 'applied' : 'rejected'),
          action: data.action || opts.action,
          affectedNodeIds: data.affectedNodeIds,
          from: target === 'orchestrator' ? 'Orchestrator' : 'Collective',
        });
        return data;
      } catch (err) {
        pushAgent(`Something went wrong: ${String(err)}`, {
          status: 'rejected',
          from: 'Orchestrator',
        });
        return null;
      } finally {
        setIsSending(false);
      }
    },
    [sessionId, projectId, selectedNodeId, onSessionUpdate, pushAgent, target]
  );

  /** Full send pipeline: user bubble + POST to /api/tasks/steer. */
  const runSend = useCallback(
    async (msgText: string) => {
      onMessages((prev) => [
        ...prev,
        {
          sender: 'user',
          from: 'You',
          text: msgText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      await sendSteer({
        message: msgText,
        nodeId: selectedNodeId || undefined,
        parentId: selectedNodeId || undefined,
      });
    },
    [onMessages, sendSteer, selectedNodeId]
  );

  const handleSendChat = async (raw?: string) => {
    const msgText = (raw ?? chatInput).trim();
    if (!msgText) return;
    setChatInput('');
    await runSend(msgText);
  };

  return (
    <div
      className={`flex flex-col h-full min-h-0 rounded-none border-0 bg-transparent overflow-hidden ${className}`}
    >
      <div className="px-4 h-11 border-b border-[#232326] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium tracking-[-0.02em] text-zinc-100">Agent</h2>
          </div>
        </div>
        {paused && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/90">
            Paused
          </span>
        )}
      </div>

      <div className="px-3 pt-2.5 flex gap-1 shrink-0">
        {(
          [
            { id: 'collective' as const, label: 'Collective', icon: Users },
            { id: 'orchestrator' as const, label: 'Orchestrator', icon: Bot },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTarget(id)}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors ${
              target === id
                ? 'bg-zinc-100 text-zinc-950'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {selectedNodeId && (
        <div className="mx-3 mt-2 text-[11px] text-zinc-500 px-2 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06]">
          Focus <span className="font-mono text-zinc-300">{selectedNodeId}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3.5 min-h-0">
        {messages.length === 0 && !busy && (
          <div className="h-full min-h-[8rem] flex items-center justify-center px-4">
            <p className="text-[12px] text-zinc-600 text-center leading-relaxed">
              Steer the swarm after a run starts. Collective broadcasts; Orchestrator plans.
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isUser = msg.sender === 'user';
          const name = msg.from || (isUser ? 'You' : 'Collective');
          return (
            <div
              key={i}
              className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
            >
              <Avatar label={name} user={isUser} />
              <div className={`flex flex-col max-w-[88%] ${isUser ? 'items-end' : 'items-start'}`}>
                <div className="flex items-center gap-2 mb-1 px-0.5">
                  <span className="text-[11px] font-medium text-zinc-400">{name}</span>
                  <span className="text-[10px] text-zinc-600">{msg.time}</span>
                </div>
                <div
                  className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                    isUser
                      ? 'bg-zinc-100 text-zinc-950'
                      : 'bg-white/[0.04] border border-white/[0.06] text-zinc-200'
                  }`}
                >
                  {msg.text}
                  {msg.status && !isUser && (
                    <div className="mt-2">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[msg.status]}`}
                      >
                        {STATUS_LABEL[msg.status]}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500 px-1">
            <RefreshCw className="w-3 h-3 animate-spin" />
            {target === 'orchestrator' ? 'Orchestrator…' : 'Relaying…'}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!sendViaParent && (
        <div className="p-3 border-t border-[#232326] shrink-0 space-y-2">
          {!sessionId && !projectId && (
            <div className="flex items-start gap-1.5 text-[11px] text-zinc-500 px-0.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              Send an objective first, then steer here.
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {SUGGESTIONS.map((hint) => (
              <button
                key={hint}
                type="button"
                disabled={busy}
                onClick={() => handleSendChat(hint)}
                className="text-[10px] px-2 py-1 rounded-md border border-white/[0.08] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors disabled:opacity-40"
              >
                {hint}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2 rounded-lg border border-[#2a2a2e] bg-[#141416] focus-within:border-zinc-600 px-2.5 py-1.5">
            <textarea
              ref={inputRef}
              rows={1}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendChat();
                }
              }}
              placeholder={
                target === 'orchestrator'
                  ? 'Message the orchestrator…'
                  : 'Message the collective…'
              }
              className="flex-1 bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none max-h-28 py-1.5 leading-relaxed"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => handleSendChat()}
              disabled={busy || !chatInput.trim()}
              className="shrink-0 w-7 h-7 rounded-md bg-zinc-100 text-zinc-950 flex items-center justify-center disabled:opacity-25 hover:bg-white transition-colors"
              aria-label="Send"
            >
              {busy ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowUp className="w-3.5 h-3.5" strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
