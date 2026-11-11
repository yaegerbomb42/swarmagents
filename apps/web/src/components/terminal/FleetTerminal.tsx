'use client';

import { useCallback } from 'react';
import ConsoleTerminal from '@/components/ConsoleTerminal';
import { unifiedApi } from '@/lib/api_client';

export type FleetTerminalProps = {
  sessionId?: string;
  className?: string;
};

export default function FleetTerminal({
  sessionId = 'fleet-mission-control',
  className = '',
}: FleetTerminalProps) {
  const onCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    const [head, ...rest] = trimmed.split(/\s+/);

    if (head === 'fleet') {
      const snap = await unifiedApi.missionSnapshot();
      const c = snap.fleet.counts;
      return [
        `mode: ${snap.launch_mode}`,
        `pending: ${c.pending} · completed: ${c.completed} · blocked: ${c.blocked}`,
        `locks: ${snap.fleet.active_locks.length}`,
        `checkpoints: ${snap.checkpoints.map((p) => `${p.label}=${p.status}`).join(' → ')}`,
      ].join('\n');
    }

    if (head === 'workers') {
      const snap = await unifiedApi.missionSnapshot();
      if (!snap.fleet.active_locks.length) return 'no active worker locks';
      return snap.fleet.active_locks
        .map((l) => `${l.worker_id} → ${l.file_path}`)
        .join('\n');
    }

    if (head === 'consensus') {
      const data = await unifiedApi.groupchatConsensus();
      const c = data.consensus as { accepted?: boolean; final_proposal?: string };
      return `consensus: ${c.accepted ? 'ACCEPTED' : 'REJECTED'}\n${c.final_proposal ?? ''}`;
    }

    if (head === 'run' && rest.length) {
      const result = await unifiedApi.missionShell(rest.join(' '));
      if (result.timed_out) return 'error: command timed out';
      if (result.exit_code !== 0) return `error: ${result.stderr || 'non-zero exit'}`;
      return result.stdout || '(ok)';
    }

    if (head === 'help') {
      return [
        'Fleet Mission Terminal',
        '  fleet      — fleet orchestrator snapshot',
        '  workers    — active file locks',
        '  consensus  — run groupchat consensus demo',
        '  run <cmd>  — sandboxed shell via mission API',
        '  help       — this message',
      ].join('\n');
    }

    return null;
  }, []);

  return (
    <ConsoleTerminal
      sessionId={sessionId}
      className={className}
      onCommand={onCommand}
      initialLines={[
        {
          id: 'fleet_boot',
          kind: 'system',
          text: 'Fleet Mission Terminal · type `help` for launch commands',
        },
      ]}
    />
  );
}
