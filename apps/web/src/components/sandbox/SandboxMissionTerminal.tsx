'use client';

import { useMemo } from 'react';
import ConsoleTerminal, { type TerminalLine } from '@/components/ConsoleTerminal';
import { useMissionTerminalFeed } from '@/hooks/useMissionTerminalFeed';
import type { AgentSandbox, SandboxLogLine } from '@/lib/sandboxTypes';

type Props = {
  sandbox: AgentSandbox;
  className?: string;
};

function bootLines(logs?: SandboxLogLine[]): TerminalLine[] | undefined {
  if (!logs?.length) return undefined;
  return logs.map((t, i) => ({
    id: `boot_${i}`,
    kind: t.kind === 'stderr' || t.kind === 'error' ? ('error' as const) : 'output',
    text: t.text,
  }));
}

export default function SandboxMissionTerminal({ sandbox, className = '' }: Props) {
  const { lines: feedLines, connected } = useMissionTerminalFeed(sandbox.id);
  const initialLines = useMemo(() => bootLines(sandbox.logs), [sandbox.logs]);

  return (
    <ConsoleTerminal
      sessionId={sandbox.id}
      className={className}
      initialLines={initialLines}
      feedLines={feedLines}
      connection={connected ? 'connected' : 'disconnected'}
      onCommand={(cmd) => {
        if (cmd === 'status') {
          return `agent: ${sandbox.label || sandbox.agentId} · telemetry: ${connected ? 'live' : 'offline'}`;
        }
        return null;
      }}
    />
  );
}
