'use client';

import { useEffect, useState } from 'react';
import SystemHealthBar from './SystemHealthBar';

export default function SystemStatusFooter({ className }: { className?: string }) {
  const [engineReachable, setEngineReachable] = useState(false);
  const [workerCount, setWorkerCount] = useState(0);
  const [aggregateTps, setAggregateTps] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [lastUpdate, setLastUpdate] = useState(0);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/engine/health');
        const data = await res.json();
        if (data) {
          setEngineReachable(true);
          setWorkerCount(data.active_agents ?? 0);
          setAggregateTps(data.throughput ?? 0);
          setPhase(data.status ?? data.orchestrator_lifecycle ?? 'idle');
          setLastUpdate(Date.now());
        }
      } catch {
        setEngineReachable(false);
        setLastUpdate(Date.now());
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <SystemHealthBar
      engineReachable={engineReachable}
      workerCount={workerCount}
      aggregateTps={aggregateTps}
      phase={phase}
      lastUpdate={lastUpdate}
      className={className}
    />
  );
}