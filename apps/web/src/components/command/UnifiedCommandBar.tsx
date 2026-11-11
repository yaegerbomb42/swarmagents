'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Clock, Loader2, Paperclip, Square, X } from 'lucide-react';
import type { TimeBudgetValue } from '@/components/TimeBudgetControl';
import {
  formatFileSize,
  processFiles,
  revokePreview,
  type AttachedMedia,
} from './attachments';

export type CommandBarMode = 'launch' | 'steer';

export interface AttachedFile {
  name: string;
  size: number;
  type: string;
  content?: string;
}

export interface UnifiedCommandBarProps {
  /** launch: mission launcher. steer: steering relay while a session is live. */
  mode: CommandBarMode;
  value?: string;
  onValueChange?: (next: string) => void;
  budget?: TimeBudgetValue;
  onBudgetChange?: (next: TimeBudgetValue) => void;
  budgetOptions?: TimeBudgetValue[];
  disabled?: boolean;
  placeholder?: string;
  /** launch mode */
  onLaunch?: (payload: { text: string; files: AttachedFile[]; images: AttachedFile[] }) => void;
  launchPending?: boolean;
  onAbort?: () => void;
  /** steer mode */
  onSteerSend?: (text: string) => void | Promise<void>;
  steerBusy?: boolean;
  className?: string;
}

const DEFAULT_BUDGET_OPTIONS: TimeBudgetValue[] = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 240, label: '4h' },
  { minutes: 1440, label: '1d' },
];

/**
 * The single command bar for the console (Linear/Raycast-minimal).
 * Replaces the duplicated aero launcher + legacy input cluster.
 */
export default function UnifiedCommandBar({
  mode,
  value,
  onValueChange,
  budget,
  onBudgetChange,
  budgetOptions = DEFAULT_BUDGET_OPTIONS,
  disabled = false,
  placeholder = mode === 'steer' ? 'Steer the swarm…' : 'Describe a mission…',
  onLaunch,
  launchPending = false,
  onAbort,
  onSteerSend,
  steerBusy = false,
  className = '',
}: UnifiedCommandBarProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachedMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sweep, setSweep] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const controlled = typeof value === 'string' && typeof onValueChange === 'function';
  const textValue = controlled ? (value ?? '') : text;

  const setTextValue = useCallback(
    (next: string) => {
      if (controlled) onValueChange?.(next);
      else setText(next);
    },
    [controlled, onValueChange]
  );

  const canSend =
    !disabled &&
    (mode === 'steer'
      ? !steerBusy && textValue.trim().length > 0
      : textValue.trim().length > 0 || attachments.length > 0);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      revokePreview(item);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const ingest = useCallback(async (list: FileList | File[]) => {
    if (!list || (Array.isArray(list) && list.length === 0)) return;
    setBusy(true);
    try {
      const items = await processFiles(list);
      setAttachments((prev) => [...prev, ...items]);
      setSweep((s) => s + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  const submit = useCallback(() => {
    if (mode === 'steer') {
      const t = textValue.trim();
      if (!t || steerBusy || disabled) return;
      void onSteerSend?.(t);
      if (!controlled) setText('');
      return;
    }
    if (launchPending || disabled) return;
    const t = textValue.trim();
    if (!t && attachments.length === 0) return;
    const files: AttachedFile[] = attachments
      .filter((a) => a.category !== 'image')
      .map((a) => ({ name: a.name, size: a.size, type: a.type, content: a.textContent }));
    const images: AttachedFile[] = attachments
      .filter((a) => a.category === 'image')
      .map((a) => ({ name: a.name, size: a.size, type: a.type }));
    if (!controlled) {
      setText('');
      setAttachments([]);
    }
    onLaunch?.({ text: t, files, images });
  }, [mode, textValue, steerBusy, disabled, launchPending, attachments, controlled, onSteerSend, onLaunch]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      void ingest(items);
    }
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    void ingest(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) void ingest(e.dataTransfer.files);
  };

  const onSubmitButton = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  useEffect(() => {
    if (dragging) {
      const clear = () => setDragging(false);
      window.addEventListener('drop', clear);
      window.addEventListener('dragend', clear);
      return () => {
        window.removeEventListener('drop', clear);
        window.removeEventListener('dragend', clear);
      };
    }
  }, [dragging]);

  const pending = mode === 'steer' ? steerBusy : launchPending;

  return (
    <form
      data-testid="unified-command-bar"
      data-mode={mode}
      data-dragging={dragging ? 'true' : 'false'}
      onSubmit={onSubmitButton}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`relative rounded-lg border bg-white/[0.02] transition-colors focus-within:border-zinc-600 ${
        dragging ? 'border-cyan-400/50' : 'border-white/[0.08]'
      } ${className}`}
    >
      <div className="px-3 pt-2.5 pb-1.5">
        <textarea
          ref={textAreaRef}
          rows={1}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          data-testid="unified-input"
          aria-label={mode === 'steer' ? 'Steering message' : 'Mission objective'}
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none max-h-32"
        />
        {mode === 'launch' && attachments.length > 0 && (
          <div data-testid="unified-attachments" className="mt-1 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 max-w-[200px] rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-zinc-400"
              >
                <span className="truncate" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 font-mono text-zinc-600">{formatFileSize(a.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove attachment ${a.name}`}
                  title="Remove"
                  onClick={() => removeAttachment(a.id)}
                  className="shrink-0 text-zinc-600 hover:text-zinc-200"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-white/[0.06] px-2 py-1.5">
        {mode === 'launch' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || busy}
              aria-label="Attach files"
              title="Attach files"
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-40"
            >
              <Paperclip size={12} />
              Attach
              {busy && <Loader2 size={10} className="animate-spin" aria-hidden />}
            </button>
            <div className="ml-1 flex items-center gap-1" role="radiogroup" aria-label="Time budget">
              <Clock size={11} className="text-zinc-600" aria-hidden />
              {budgetOptions.map((b) => (
                <button
                  key={b.label}
                  type="button"
                  role="radio"
                  aria-checked={budget?.label === b.label}
                  data-testid="budget-option"
                  disabled={disabled || launchPending}
                  onClick={() => onBudgetChange?.(b)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition ${
                    budget?.label === b.label
                      ? 'bg-cyan-500/15 text-cyan-300'
                      : 'text-zinc-500 hover:text-zinc-300'
                  } disabled:opacity-40`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {onAbort && pending && (
            <button
              type="button"
              onClick={onAbort}
              aria-label="Abort run"
              title="Abort"
              data-testid="command-abort"
              className="inline-flex items-center gap-1 rounded border border-rose-500/25 px-2 py-1 text-[10px] text-rose-400 hover:bg-rose-500/10"
            >
              <Square size={9} className="fill-rose-300" aria-hidden />
              Abort
            </button>
          )}
          {pending && <Loader2 size={12} className="animate-spin text-zinc-500" aria-label="Working" />}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={mode === 'steer' ? 'Send steering message' : 'Launch mission'}
            data-testid="unified-send"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:opacity-25"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {mode === 'launch' && (
        <div className="pointer-events-none absolute inset-x-3 bottom-0 z-0 opacity-60" aria-hidden>
          <svg data-testid="focus-sweep" className="h-[1px] w-full" role="presentation" key={sweep}>
            <line
              x1="0"
              y1="0"
              x2="100%"
              y2="0"
              stroke="rgba(34, 211, 238, 0.55)"
              strokeWidth="1"
              strokeDasharray="80 160"
            />
          </svg>
        </div>
      )}
    </form>
  );
}





