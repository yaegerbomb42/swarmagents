"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Attachment, ContextInfo } from "@/lib/types";
import { IAttach, IFile, IStop, IUp, IX, ISlash, IModel, IKeyboard } from "./icons";
import { fmtK } from "./Timeline";

interface Pending {
  key: string;
  name: string;
  progress: number;
  file: File;
  att?: Attachment;
  error?: string;
}

// Per-browser conveniences: an unsent draft survives reloads, and ↑/↓ walk previously sent messages.
const DRAFT_KEY = "swarm.draft";
const HISTORY_KEY = "swarm.sent";
const store = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string | null) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {}
  },
};
const sentHistory = (): string[] => {
  try { return JSON.parse(store.get(HISTORY_KEY) ?? "[]") as string[]; } catch { return []; }
};

function upload(file: File, sessionId: string, onProgress: (p: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?session=${sessionId}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 300) {
        let message = `Upload failed (HTTP ${xhr.status}).`;
        try {
          const body: unknown = JSON.parse(xhr.responseText);
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error;
        } catch { if (xhr.responseText.trim()) message = xhr.responseText.trim(); }
        reject(new Error(message));
        return;
      }
      try { resolve(JSON.parse(xhr.responseText) as Attachment); } catch { reject(new Error("The server returned an invalid upload response.")); }
    };
    xhr.onerror = () => reject(new Error("connection lost"));
    xhr.send(file);
  });
}

// Slash commands
const SLASH_COMMANDS = [
  { cmd: "/plan", desc: "Create a plan", action: "plan" },
  { cmd: "/search", desc: "Search the web", action: "search" },
  { cmd: "/browser", desc: "Open browser", action: "browser" },
  { cmd: "/compact", desc: "Compact context", action: "compact" },
  { cmd: "/clear", desc: "Clear conversation", action: "clear" },
  { cmd: "/help", desc: "Show shortcuts", action: "help" },
];

// Model options (would come from settings in real app)
const MODELS = [
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai" },
  { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", provider: "anthropic" },
  { id: "claude-3-haiku", label: "Claude 3 Haiku", provider: "anthropic" },
];

export function Composer({
  running,
  context,
  ensureSession,
  onSend,
  onStop,
}: {
  running: boolean;
  context: ContextInfo | null;
  ensureSession: () => Promise<string>;
  onSend: (text: string, atts: Attachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const dragDepth = useRef(0);
  const recall = useRef({ index: -1, draft: "" });
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const slashRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = store.get(DRAFT_KEY);
    if (saved) setText(saved);
  }, []);
  useEffect(() => { store.set(DRAFT_KEY, text || null); }, [text]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text]);

  useEffect(() => {
    ta.current?.focus();
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) setShowSlash(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setShowModels(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const add = useCallback((fileList: FileList) => {
    Array.from(fileList).forEach((file) => {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      setFiles((prev) => [...prev, { key, name: file.name, progress: 0, file }]);
      ensureSession().then((sessionId) => {
        upload(file, sessionId, (p) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, progress: p } : f))))
          .then((att) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, att, progress: 1 } : f))))
          .catch((err) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, error: err.message, progress: 0 } : f))));
      });
    });
  }, [ensureSession]);

  const retry = useCallback((f: Pending) => {
    setFiles((prev) => prev.map((x) => (x.key === f.key ? { ...x, progress: 0, error: undefined } : x)));
    ensureSession().then((sessionId) =>
      upload(f.file, sessionId, (p) => setFiles((prev) => prev.map((x) => (x.key === f.key ? { ...x, progress: p } : x))))
        .then((att) => setFiles((prev) => prev.map((x) => (x.key === f.key ? { ...x, att, progress: 1 } : x))))
        .catch((err) => setFiles((prev) => prev.map((x) => (x.key === f.key ? { ...x, error: err.message, progress: 0 } : x))))
    );
  }, [ensureSession]);

  const canSend = text.trim().length > 0 || files.some((f) => f.att);

  const send = useCallback(() => {
    if (!canSend) return;
    const atts = files.filter((f) => f.att).map((f) => f.att!);
    const currentText = text;
    setText("");
    setFiles([]);
    setShowSlash(false);
    store.set(HISTORY_KEY, JSON.stringify([currentText, ...sentHistory()].slice(0, 50)));
    recall.current = { index: -1, draft: "" };
    onSend(currentText, atts);
  }, [canSend, files, onSend, text]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    // Cmd+Enter = Send
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }

    // Enter = Send (no shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }

    // Esc = Stop (when running) or Clear slash/model dropdowns
    if (e.key === "Escape") {
      if (running) { onStop(); return; }
      setShowSlash(false);
      setShowModels(false);
      return;
    }

    // Cmd+K = Focus composer (already focused) / Show shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setShowSlash(true);
      return;
    }

    // ↑/↓ history navigation
    const el = e.currentTarget;
    const textarea = el as HTMLTextAreaElement;
    const atStart = !textarea.value.slice(0, textarea.selectionStart).includes("\n");
    const atEnd = !textarea.value.slice(textarea.selectionEnd).includes("\n");
    if ((e.key === "ArrowUp" && atStart) || (e.key === "ArrowDown" && atEnd && recall.current.index >= 0)) {
      const hist = sentHistory();
      const r = recall.current;
      const next = e.key === "ArrowUp" ? (r.index < 0 ? hist.length - 1 : r.index - 1) : r.index + 1;
      if (e.key === "ArrowUp" && (next < 0 || !hist.length)) return;
      e.preventDefault();
      if (r.index < 0) r.draft = text;
      if (next >= hist.length) { r.index = -1; setText(r.draft); }
      else { r.index = next; setText(hist[next]); }
    }

    // Trigger slash menu on /
    if (e.key === "/" && atStart && text === "") {
      e.preventDefault();
      setShowSlash(true);
    }
  }, [running, onStop, send, text]);

  const handleSlashSelect = (cmd: typeof SLASH_COMMANDS[0]) => {
    setText(cmd.cmd + " ");
    setShowSlash(false);
    ta.current?.focus();
  };

  const pct = context && context.window > 0 ? Math.min(100, (context.tokens / context.window) * 100) : 0;

  return (
    <div className="composer-wrap">
      <div className="composer">
        {/* Attachments bar */}
        {files.length > 0 && (
          <div className="files-bar" role="list" aria-label="Attachments">
            {files.map((f) => (
              <span key={f.key} className="file-chip" role="listitem">
                <IFile />
                <span className="name" title={f.name}>{f.name}</span>
                {f.progress < 1 && <span className="progress" style={{ width: `${f.progress * 100}%` }} />}
                {f.error && <span className="error">{f.error}</span>}
                <button className="rm" onClick={() => setFiles((x) => x.filter((y) => y.key !== f.key))} aria-label="Remove">
                  <IX />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div style={{ position: "relative" }}>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={running ? "Add guidance while it works…" : "What should we get done?"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files); }
            }}
            onFocus={() => { if (text.startsWith("/")) setShowSlash(true); }}
            aria-label="Message composer"
          />

          {/* Slash command dropdown */}
          {showSlash && (
            <div className="slash-menu" ref={slashRef} role="menu">
              {SLASH_COMMANDS.map((cmd) => (
                <button
                  key={cmd.cmd}
                  className="slash-item"
                  role="menuitem"
                  onClick={() => handleSlashSelect(cmd)}
                >
                  <ISlash />
                  <span><strong>{cmd.cmd}</strong> {cmd.desc}</span>
                </button>
              ))}
              <div className="slash-divider" />
              <button className="slash-item" onClick={() => { setShowSlash(false); setShowModels(true); }}> <IModel /> <span>Switch model…</span> </button>
              <button className="slash-item" onClick={() => { setShowSlash(false); alert("Shortcuts:\nEnter — Send\nShift+Enter — New line\nCmd+Enter — Send\nEsc — Stop / Close\nCmd+K — Commands\n↑/↓ — History"); }}> <IKeyboard /> <span>Keyboard shortcuts</span> </button>
            </div>
          )}
        </div>

        {/* Footer row */}
        <div className="row">
          <button className="icon-btn attach" title="Attach files (any size)" onClick={() => picker.current?.click()} aria-label="Attach files">
            <IAttach />
          </button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => e.target.files && (add(e.target.files), (e.target.value = ""))} />

          {/* Model picker chip */}
          <div className="model-picker" ref={modelRef}>
            <button
              className="model-chip"
              onClick={() => setShowModels(!showModels)}
              aria-expanded={showModels}
              aria-haspopup="menu"
            >
              <IModel />
              <span>{MODELS.find(m => m.id === selectedModel)?.label ?? selectedModel}</span>
              <IChevron open={showModels} />
            </button>
            {showModels && (
              <div className="model-dropdown" role="menu">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    className={`model-option ${selectedModel === m.id ? "selected" : ""}`}
                    role="menuitem"
                    onClick={() => { setSelectedModel(m.id); setShowModels(false); }}
                  >
                    <span>{m.label}</span>
                    <span className="provider">{m.provider}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {context && context.tokens > 0 && (
            <span className="meter" title={`${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens${context.model ? ` · ${context.model}` : ""}`}>
              {fmtK(context.tokens)} / {fmtK(context.window)}
              <span className="track"><span className="fill" style={{ width: `${pct}%` }} /></span>
            </span>
          )}
          {!context?.tokens && <span className="spacer" />}

          {running && (
            <button className="send stop" title="Stop (Esc)" onClick={onStop} aria-label="Stop">
              <IStop />
            </button>
          )}
          {(!running || text.trim()) && (
            <button className="send" disabled={!canSend} onClick={send} title="Send (Enter)" aria-label="Send">
              <IUp />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
