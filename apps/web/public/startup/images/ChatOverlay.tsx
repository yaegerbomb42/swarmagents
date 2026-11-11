"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Cpu, Activity, BrainCircuit } from "lucide-react";
import { motion } from "framer-motion";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function ChatOverlay() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      let aiMessageContent = "";
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: "" },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        aiMessageContent += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1].content = aiMessageContent;
          return updated;
        });
      }
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-between pointer-events-none p-6">
      
      {/* Header / Stats */}
      <div className="flex justify-between items-start pointer-events-auto w-full max-w-7xl mx-auto">
        <div className="flex flex-col gap-2 bg-black/40 backdrop-blur-md p-4 rounded-xl border border-white/10 shadow-2xl">
          <div className="flex items-center gap-3 text-white/90 font-mono text-sm">
            <BrainCircuit className="w-5 h-5 text-purple-400" />
            <span className="font-bold tracking-wider">AGI KERNEL v1.0.4</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-white/50 font-mono mt-1">
            <div className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-green-400" />
              <span>OSC: GAMMA (40Hz)</span>
            </div>
            <div className="flex items-center gap-1">
              <Cpu className="w-3 h-3 text-blue-400" />
              <span>TOPOLOGY: DYNAMIC</span>
            </div>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex flex-col items-center justify-end w-full max-w-3xl mx-auto pointer-events-auto h-[60vh]">
        <div className="w-full flex-1 overflow-y-auto mb-6 pr-2 space-y-6 scrollbar-hide flex flex-col justify-end mask-image-b">
          <div className="flex flex-col space-y-6">
            {messages.length === 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center text-white/40 font-mono text-sm py-10"
              >
                System initialized. Tri-partite memory online. Awaiting neural input...
              </motion.div>
            )}
            
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div 
                  className={
                    "max-w-[80%] rounded-2xl px-5 py-3 font-mono text-sm leading-relaxed backdrop-blur-md shadow-lg border " +
                    (m.role === "user" 
                      ? "bg-white/10 text-white/90 border-white/10" 
                      : "bg-black/60 text-emerald-300 border-emerald-900/50")
                  }
                >
                  {m.role === "assistant" && (
                    <div className="flex items-center gap-2 mb-2 text-emerald-500/70 text-xs font-bold tracking-widest uppercase">
                      <BrainCircuit className="w-3 h-3" /> Agent
                    </div>
                  )}
                  {m.content}
                </div>
              </motion.div>
            ))}
            {isLoading && messages.length % 2 !== 0 && (
              <div className="flex justify-start">
                <div className="bg-black/60 border border-emerald-900/50 rounded-2xl px-5 py-4 backdrop-blur-md">
                  <div className="flex space-x-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: "-0.3s" }}></div>
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: "-0.15s" }}></div>
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce"></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Form */}
        <form 
          onSubmit={handleSubmit} 
          className="w-full relative group"
        >
          <div className="absolute -inset-0.5 bg-gradient-to-r from-purple-500/30 to-blue-500/30 rounded-xl blur opacity-75 group-hover:opacity-100 transition duration-500"></div>
          <div className="relative flex items-center bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-2 shadow-2xl">
            <input
              className="flex-1 bg-transparent text-white/90 placeholder:text-white/30 px-4 py-3 outline-none font-mono text-sm w-full"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Inject linguistic stimulus..."
            />
            <button 
              type="submit" 
              disabled={isLoading || !input.trim()}
              className="p-3 mr-1 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
