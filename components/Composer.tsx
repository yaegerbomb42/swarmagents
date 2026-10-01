"use client";
import { useEffect, useRef, useState } from "react";
import type { Attachment, ContextInfo } from "@/lib/types";
import { IAttach, IFile, IStop, IUp, IX } from "./icons";
import { fmtK } from "./Timeline";

interface Pending {
  key: string;
  name: string;
  progress: number;
  att?: Attachment;
  error?: string;
}

function upload(file: File, sessionId: string, onProgress: (p: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?session=${sessionId}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText || `HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("upload failed"));
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
    const esc = (e: KeyboardEvent) => e.key === "Escape" && running && onStop();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [running, onStop]);

  const add = async (list: FileList | File[]) => {
    const sid = await ensureSession();
    for (const f of Array.from(list)) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setFiles((x) => [...x, { key, name: f.name, progress: 0 }]);
      upload(f, sid, (p) => setFiles((x) => x.map((y) => (y.key === key ? { ...y, progress: p } : y))))
        .then((att) => setFiles((x) => x.map((y) => (y.key === key ? { ...y, att, progress: 1 } : y))))
        .catch((e) => setFiles((x) => x.map((y) => (y.key === key ? { ...y, error: e.message } : y))));
    }
  };

  const uploading = files.some((f) => !f.att && !f.error);
  const canSend = (text.trim() || files.some((f) => f.att)) && !uploading;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), files.filter((f) => f.att).map((f) => f.att!));
    setText("");
    setFiles([]);
  };

  const pct = context?.window ? Math.min(100, (context.tokens / context.window) * 100) : 0;

  return (
    <div className="composer-wrap">
      <div
        className={`composer${drag ? " drag" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
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
                  {!f.att && !f.error && ` · ${Math.round(f.progress * 100)}%`}
                </span>
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
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
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
