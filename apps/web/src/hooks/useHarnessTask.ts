'use client';

import { useState, useRef, useCallback } from 'react';

export type HarnessEvent = { seq: number; ts: number; type: string; [k: string]: unknown };
export type HarnessStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export function useHarnessTask(): {
  events: HarnessEvent[];
  status: HarnessStatus;
  taskId: string | null;
  finalText: string;
  files: { path: string; content: string }[];
  error: string | null;
  dispatch: (input: { prompt: string; cluster?: string; title?: string; token?: string }) => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [status, setStatus] = useState<HarnessStatus>('idle');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [finalText, setFinalText] = useState('');
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setStatus('cancelled');
  }, []);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    generationRef.current += 1;
    setEvents([]);
    setStatus('idle');
    setTaskId(null);
    setFinalText('');
    setFiles([]);
    setError(null);
  }, []);

  const dispatch = useCallback(async (input: { prompt: string; cluster?: string; title?: string; token?: string }) => {
    generationRef.current += 1;
    const generation = generationRef.current;

    abortControllerRef.current?.abort();
    setEvents([]);
    setStatus('running');
    setTaskId(null);
    setFinalText('');
    setFiles([]);
    setError(null);

    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;

    const isActive = () => generationRef.current === generation;
    let sawDone = false;

    try {
      const res = await fetch('/api/harness/task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        body: JSON.stringify({
          prompt: input.prompt,
          provider: input.cluster,
          title: input.title,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let message: string;
        try {
          const body = await res.json();
          message =
            typeof body?.message === 'string'
              ? body.message
              : typeof body?.error === 'string'
                ? body.error
                : JSON.stringify(body);
        } catch {
          message = res.statusText || String(res.status);
        }
        if (isActive()) {
          setError(message);
          setStatus('failed');
        }
        return;
      }

      if (!res.body) {
        if (isActive()) {
          setError('No response body');
          setStatus('failed');
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let dataLines: string[] = [];
      let eventName: string | undefined;

      const flushFrame = () => {
        if (!isActive()) {
          dataLines = [];
          eventName = undefined;
          return;
        }
        if (dataLines.length || eventName != null) {
          const dataStr = dataLines.join('\n');
          let parsed: HarnessEvent | undefined;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            // ignore malformed data
          }
          if (parsed) {
            setEvents((prev) => {
              const next = [...prev, parsed!];
              if (next.length > 500) {
                next.shift();
              }
              return next;
            });

            if (parsed.type === 'task.accepted') {
              if (typeof parsed.taskId === 'string') {
                setTaskId(parsed.taskId);
              }
            } else if (parsed.type === 'task.done') {
              sawDone = true;
              const doneStatus = parsed.status;
              if (doneStatus === 'completed' || doneStatus === 'failed') {
                setStatus(doneStatus);
              } else {
                setStatus('failed');
              }
              setFinalText(typeof parsed.finalText === 'string' ? parsed.finalText : '');
              const incomingFiles = Array.isArray(parsed.files)
                ? parsed.files.filter(
                    (f: unknown): f is { path: string; content: string } =>
                      f !== null &&
                      typeof (f as Record<string, unknown>).path === 'string' &&
                      typeof (f as Record<string, unknown>).content === 'string'
                  )
                : [];
              setFiles(incomingFiles);
            } else if (parsed.type === 'task.error') {
              sawDone = true;
              setStatus('failed');
              setError(typeof parsed.message === 'string' ? parsed.message : 'Unknown error');
            }
          }
        }
        dataLines = [];
        eventName = undefined;
      };

      const feed = (chunk: string) => {
        buf += chunk;
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
          const line = buf.slice(0, nl);
          const sepLen = buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1;
          if (buf[nl] === '\r' && nl + 1 === buf.length) break;
          buf = buf.slice(nl + sepLen);

          if (line === '') {
            flushFrame();
            continue;
          }
          if (line.startsWith(':')) continue;
          const c = line.indexOf(':');
          const field = c < 0 ? line : line.slice(0, c);
          let value = c < 0 ? '' : line.slice(c + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') dataLines.push(value);
          else if (field === 'event') eventName = value;
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode());
    } catch (err) {
      if (!isActive()) return;
      if (ctrl.signal.aborted) {
        setStatus('cancelled');
      } else {
        setError((err as Error)?.message ?? 'Stream error');
        setStatus('failed');
      }
      return;
    }

    if (!isActive()) return;
    if (!sawDone && !ctrl.signal.aborted) {
      setStatus('failed');
      setError('stream ended early');
    }
  }, []);

  return {
    events,
    status,
    taskId,
    finalText,
    files,
    error,
    dispatch,
    cancel,
    reset,
  };
}
