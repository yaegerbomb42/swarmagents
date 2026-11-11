"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Cpu, User, Loader2, RefreshCw } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  latency?: number;
  error?: boolean;
}

const MODEL_OPTIONS = [
  { id: "auto", name: "Auto (Local → Cloud)" },
  { id: "ceo_brain", name: "70B CEO Brain" },
  { id: "specialist_moe", name: "35B MoE Specialist" },
  { id: "grunt_8b", name: "8B Grunt" },
  { id: "gemma_12b", name: "Gemma 12B" },
  { id: "deepseek_flash", name: "DeepSeek v4 Flash" },
];

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "system", content: "SwarmAgent Chat — Local models with DeepSeek v4 Flash failover." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("auto");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg: ChatMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const contextMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input,
          model_preference: selectedModel === "auto" ? undefined : selectedModel,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response, model: data.model_used, latency: data.latency_ms },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error || "Unknown"}`, error: true },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Network error: ${String(e)}`, error: true }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const clearChat = () => {
    setMessages([{ role: "system", content: "SwarmAgent Chat — Local models with DeepSeek v4 Flash failover." }]);
  };

  return (
    <div className="flex flex-col h-full rounded-xl border border-white/[0.04] bg-[#06061a] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-cyan-400" />
          <span className="text-xs font-semibold text-white/70">Swarm Chat</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="text-[10px] bg-white/[0.03] border border-white/[0.08] rounded-lg px-2 py-1 text-white/60 focus:outline-none focus:border-cyan-500/30"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id} className="bg-[#06061a]">{m.name}</option>
            ))}
          </select>
          <button onClick={clearChat} className="text-white/20 hover:text-white/50 transition-colors">
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role !== "user" && <Cpu size={14} className="mt-1 shrink-0 text-cyan-400/60" />}
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
              msg.role === "user"
                ? "bg-cyan-500/10 border border-cyan-500/20 text-cyan-100"
                : msg.error
                ? "bg-red-500/10 border border-red-500/20 text-red-200"
                : "bg-white/[0.03] border border-white/[0.06] text-white/80"
            }`}>
              {msg.role === "assistant" && msg.model && (
                <div className="text-[9px] uppercase tracking-wider text-white/30 mb-1 flex items-center gap-1">
                  <span className="text-cyan-400/60">{msg.model}</span>
                  {msg.latency !== undefined && <span>{msg.latency.toFixed(0)}ms</span>}
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
            {msg.role === "user" && <User size={14} className="mt-1 shrink-0 text-white/40" />}
          </div>
        ))}
        {loading && (
          <div className="flex gap-2">
            <Cpu size={14} className="mt-1 shrink-0 text-cyan-400/60" />
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
              <Loader2 size={12} className="animate-spin text-cyan-400" />
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-white/[0.04]">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the swarm..."
            rows={2}
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-white/20 resize-none focus:outline-none focus:border-cyan-500/30 transition-colors"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="shrink-0 bg-gradient-to-r from-cyan-500 to-purple-600 text-white rounded-lg px-3 py-2 disabled:opacity-30 transition-opacity"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
