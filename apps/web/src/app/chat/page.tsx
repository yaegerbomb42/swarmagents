"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Loader2, Sparkles, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import RequireAuth from '@/components/auth/RequireAuth';
import ConsoleShell from '@/components/ConsoleShell';
import Link from "next/link";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT =
  "You are the SwarmAgents architect — a sharp, practical AI assistant for planning and building software and research projects. Help the user scope goals, decompose work into concrete tasks, and make technical decisions. Be concise, use markdown when helpful, and prefer actionable answers.";

const SUGGESTIONS = [
  "Help me scope an MVP for a habit-tracking app.",
  "Break down building a REST API for a bookstore.",
  "What's a good architecture for a real-time chat app?",
  "Draft a launch checklist for a SaaS landing page.",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    const history = [...messages, { role: "user" as const, content: trimmed }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: `⚠️ ${message}. Please try again.` };
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const empty = messages.length === 0;
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content;

  return (
    <RequireAuth>
      <ConsoleShell>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 min-h-0">
        <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto pb-4">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-purple-600 shadow-lg shadow-cyan-500/20">
                <Sparkles className="h-7 w-7 text-white" />
              </div>
              <h1 className="text-2xl font-semibold">Chat with the SwarmAgents architect</h1>
              <p className="mt-2 max-w-md text-sm text-white/50">
                Scope projects, decompose work, and make technical decisions — powered by DeepSeek V4 Flash.
              </p>
              <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm text-white/70 transition-colors hover:border-cyan-400/30 hover:bg-cyan-400/[0.05]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                {m.role === "assistant" && (
                  <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-purple-600">
                    <Sparkles className="h-4 w-4 text-white" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-cyan-400 text-black"
                      : "border border-white/10 bg-white/[0.04] text-white/90"
                  }`}
                >
                  {m.content ? (
                    m.role === "assistant" ? (
                      <div className="chat-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      m.content
                    )
                  ) : isStreaming && i === messages.length - 1 ? (
                    <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
                  ) : (
                    ""
                  )}
                </div>
                {m.role === "user" && (
                  <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-white/10 bg-white/5">
                    <User className="h-4 w-4 text-white/60" />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="sticky bottom-0 rounded-2xl border border-cyan-400/15 bg-[#0a0a14]/90 p-3 backdrop-blur">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the architect anything about your project…"
              rows={1}
              className="max-h-40 flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-cyan-400/50"
            />
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() || isStreaming}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 text-black transition-all hover:shadow-lg hover:shadow-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              aria-label="Send message"
            >
              {isStreaming ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
          <p className="mt-2 px-1 text-[11px] text-white/30">
            Enter to send · Shift+Enter for a new line · DeepSeek V4 Flash
            {lastUser ? (
              <>
                {" · "}
                <Link
                  href={`/decomp?goal=${encodeURIComponent(lastUser.slice(0, 1800))}&autostart=1`}
                  className="text-cyan-300 hover:text-cyan-200"
                >
                  Run this in console
                </Link>
              </>
            ) : null}
          </p>
        </div>
      </div>
      </ConsoleShell>
    </RequireAuth>
  );
}
