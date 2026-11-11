'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ConsoleTerminal, { type TerminalLine } from '@/components/ConsoleTerminal';
import { unifiedApi } from '@/lib/api_client';

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

function sanitize(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

export type PtyTerminalProps = {
  sessionId?: string;
  className?: string;
};

export default function PtyTerminal({
  sessionId = 'fleet-pty',
  className = '',
}: PtyTerminalProps) {
  const [feedLines, setFeedLines] = useState<TerminalLine[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const idRef = useRef(0);

  const pushLine = useCallback((kind: TerminalLine['kind'], text: string) => {
    const clean = sanitize(text);
    if (!clean.trim()) return;
    idRef.current += 1;
    setFeedLines((prev) =>
      [...prev, { id: `pty_${idRef.current}`, kind, text: clean }].slice(-500),
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(unifiedApi.terminalWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        attempt = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string; text?: string };
          const kind: TerminalLine['kind'] =
            msg.type === 'error' ? 'error' : msg.type === 'system' ? 'system' : 'output';
          if (msg.text) pushLine(kind, msg.text);
        } catch {
          pushLine('output', String(event.data));
        }
      };

      ws.onerror = () => setWsConnected(false);

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (disposed) return;
        const delay = Math.min(5000, 200 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [pushLine]);

  const onCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    const ws = wsRef.current;

    if (ws && ws.readyState === WebSocket.OPEN) {
      if (trimmed === 'fleet') {
        ws.send(JSON.stringify({ type: 'fleet' }));
        return '';
      }
      ws.send(JSON.stringify({ type: 'run', command: trimmed }));
      return '';
    }

    if (trimmed === 'fleet') {
      const snap = await unifiedApi.missionSnapshot();
      const c = snap.fleet.counts;
      return [
        `mode: ${snap.launch_mode} (http fallback)`,
        `pending: ${c.pending} · completed: ${c.completed} · blocked: ${c.blocked}`,
      ].join('\n');
    }

    if (trimmed.startsWith('run ')) {
      const result = await unifiedApi.missionShell(trimmed.slice(4));
      if (result.timed_out) return 'error: command timed out';
      if (result.exit_code !== 0) return `error: ${sanitize(result.stderr || 'non-zero exit')}`;
      return sanitize(result.stdout || '(ok)');
    }

    return null;
  }, []);

  return (
    <div data-testid="pty-terminal" className={`flex flex-col min-h-0 ${className}`}>
      <div className="text-[10px] font-mono text-zinc-500 px-1 pb-1">
        PTY · {wsConnected ? 'websocket' : 'http fallback'}
      </div>
      <ConsoleTerminal
        sessionId={sessionId}
        className="flex-1 min-h-0"
        feedLines={feedLines}
        onCommand={onCommand}
        initialLines={[
          {
            id: 'pty_boot',
            kind: 'system',
            text: 'PTY terminal · `fleet` for status · `run <cmd>` when WS offline',
          },
        ]}
      />
    </div>
  );
}
