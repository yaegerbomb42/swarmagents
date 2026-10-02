"use client";
import { useEffect, useRef, useState } from "react";
import type { Attachment, ContextInfo } from "@/lib/types";
import { IAttach, IFile, IStop, IUp, IX } from "./icons";
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
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};
const sentHistory = (): string[] => {
  try {
    return JSON.parse(store.get(HISTORY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
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
        } catch {
          if (xhr.responseText.trim()) message = xhr.responseText.trim();
        }
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as Attachment);
      } catch {
        reject(new Error("The server returned an invalid upload response."));
      }
    };
    xhr.onerror = () => reject(new Error("connection lost"));
    xhr.send(file);
  });
}

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
  // dragenter/leave fire for every child element; count them so the highlight doesn't flicker.
  const dragDepth = useRef(0);
  // Position while browsing sent messages with ↑/↓ (-1 = editing a fresh draft), and the draft it replaced.
  const recall = useRef({ index: -1, draft: "" });

  useEffect(() => {
    const saved = store.get(DRAFT_KEY);
    if (saved) setText(saved);
  }, []);
  useEffect(() => {
    store.set(DRAFT_KEY, text || null);
  }, [text]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text]);

  useEffect(() => {
    ta.current?.focus();
    // Esc stops the run, unless it is closing something else (a dialog, an overlay, an IME composition).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !running || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('[role="dialog"], .overlay, .activity-overlay')) return;
      onStop();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [running, onStop]);

  const start = (key: string, f: File, sid: string) => {
    const set = (patch: Partial<Pending>) => setFiles((x) => x.map((y) => (y.key === key ? { ...y, ...patch } : y)));
    upload(f, sid, (progress) => set({ progress }))
      .then((att) => set({ att, progress: 1 }))
      .catch((e: Error) => set({ error: e.message }));
  };

  const add = async (list: FileList | File[]) => {
    const sid = await ensureSession();
    for (const f of Array.from(list)) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setFiles((x) => [...x, { key, name: f.name, progress: 0, file: f }]);
      start(key, f, sid);
    }
  };

  const retry = async (p: Pending) => {
    const sid = await ensureSession();
    setFiles((x) => x.map((y) => (y.key === p.key ? { ...y, error: undefined, progress: 0 } : y)));
    start(p.key, p.file, sid);
  };

  const uploading = files.some((f) => !f.att && !f.error);
  const canSend = (text.trim() || files.some((f) => f.att)) && !uploading;

  const send = () => {
    if (!canSend) return;
    const msg = text.trim();
    onSend(msg, files.filter((f) => f.att).map((f) => f.att!));
    if (msg) store.set(HISTORY_KEY, JSON.stringify([...sentHistory().filter((h) => h !== msg), msg].slice(-50)));
    recall.current = { index: -1, draft: "" };
    setText("");
    setFiles([]);
  };

  const pct = context?.window ? Math.min(100, (context.tokens / context.window) * 100) : 0;

  return (
    <div className="composer-wrap">
      <div
        className={`composer${drag ? " drag" : ""}`}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          dragDepth.current++;
          setDrag(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDrag(false);
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
      >
        {!!files.length && (
          <div className="chips">
            {files.map((f) => (
              <span key={f.key} className="chip" title={f.error ?? f.att?.path} style={f.error ? { color: "var(--err)" } : undefined}>
                <IFile />
                <span>
                  {f.name}
                  {f.error ? ` · ${f.error}` : !f.att ? ` · ${Math.round(f.progress * 100)}%` : ""}
                </span>
                {f.error && (
                  <button className="rm" title="Retry upload" onClick={() => retry(f)} style={{ width: "auto", padding: "0 4px", fontSize: 12 }}>
                    Retry
                  </button>
                )}
                <button className="rm" onClick={() => setFiles((x) => x.filter((y) => y.key !== f.key))}>
                  <IX />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={running ? "Add guidance while it works…" : "What should we get done?"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              add(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
              return;
            }
            // ↑ on the first line / ↓ on the last line walk sent messages, like a shell.
            const el = e.currentTarget;
            const atStart = !el.value.slice(0, el.selectionStart).includes("\n");
            const atEnd = !el.value.slice(el.selectionEnd).includes("\n");
            if ((e.key === "ArrowUp" && atStart) || (e.key === "ArrowDown" && atEnd && recall.current.index >= 0)) {
              const hist = sentHistory();
              const r = recall.current;
              const next = e.key === "ArrowUp" ? (r.index < 0 ? hist.length - 1 : r.index - 1) : r.index + 1;
              if (e.key === "ArrowUp" && (next < 0 || !hist.length)) return;
              e.preventDefault();
              if (r.index < 0) r.draft = text;
              if (next >= hist.length) {
                r.index = -1;
                setText(r.draft);
              } else {
                r.index = next;
                setText(hist[next]);
              }
            }
          }}
        />
        <div className="row">
          <button className="icon-btn" title="Attach files (any size)" onClick={() => picker.current?.click()}>
            <IAttach />
          </button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => e.target.files && (add(e.target.files), (e.target.value = ""))} />
          {context && context.tokens > 0 && (
            <span className="meter" title={`${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens${context.model ? ` · ${context.model}` : ""}`}>
              {fmtK(context.tokens)} / {fmtK(context.window)}
              <span className="track">
                <span className="fill" style={{ width: `${pct}%`, display: "block", background: pct > 75 ? "var(--warn)" : undefined }} />
              </span>
            </span>
          )}
          {!context?.tokens && <span className="spacer" />}
          {running && (
            <button className="send" style={{ background: "var(--sunken)", color: "var(--text)", border: "1px solid var(--line-strong)" }} title="Stop (Esc)" onClick={onStop}>
              <IStop />
            </button>
          )}
          {(!running || text.trim()) && (
            <button className="send" disabled={!canSend} onClick={send} title="Send (Enter)">
              <IUp />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
