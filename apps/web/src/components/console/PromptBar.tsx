'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * Centered floating prompt bar. Enter dispatches the mission,
 * Shift+Enter is a newline. While a mission runs the bar is disabled —
 * the harness executor has no cancellation handle (its per-call aborts
 * are internal timeouts), so there is deliberately no stop button that
 * would pretend to stop it.
 */
export function PromptBar({
  running,
  onSend,
  autoFocus = true,
}: {
  running: boolean;
  onSend: (text: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus]);

  const send = () => {
    const value = text.trim();
    if (!value || running) return;
    setText('');
    onSend(value);
  };

  return (
    <div className="w-full">
      <div className="rounded-r-lg border border-line-2 bg-bg-1 shadow-e1 focus-within:border-accent/50 focus-within:shadow-focus transition-shadow duration-fast ease-out">
        <textarea
          ref={ta}
          value={text}
          rows={2}
          disabled={running}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            running
              ? 'Mission running — the bar unlocks when it finishes…'
              : 'Describe the mission…'
          }
          aria-label="Mission prompt"
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-fg-1 placeholder:text-fg-4 focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <span className="font-mono text-micro text-fg-4">
            Enter to dispatch · Shift+Enter for a new line
          </span>
          <button
            type="button"
            onClick={send}
            disabled={!text.trim() || running}
            aria-label="Dispatch mission"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-zinc-950 transition-colors duration-fast ease-out hover:bg-accent-strong disabled:opacity-40 disabled:hover:bg-accent"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
