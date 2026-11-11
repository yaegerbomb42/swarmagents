'use client';

import React, { useEffect, useState } from 'react';
import { Bot, Activity, AlertCircle, CheckCircle, PauseCircle, XCircle } from 'lucide-react';
import { motion } from 'framer-motion';

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  idle:     { icon: CheckCircle, color: 'text-gray-400',   bg: 'bg-gray-500/10' },
  running:  { icon: Activity,    color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  paused:   { icon: PauseCircle, color: 'text-amber-400',   bg: 'bg-amber-500/10' },
  error:    { icon: XCircle,     color: 'text-red-400',     bg: 'bg-red-500/10' },
  degraded: { icon: AlertCircle, color: 'text-orange-400',  bg: 'bg-orange-500/10' },
};

export default function AgentStatusPanel() {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchAgents = async () => {
      try {
        const ENGINE = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:8400';
        const res = await fetch(`${ENGINE}/agents`, { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setAgents(data.agents || []);
          setError(null);
        } else {
          const apiRes = await fetch('/api/agents', { cache: 'no-store' });
          const data = await apiRes.json();
          setAgents(data.agents || []);
        }
      } catch {
        if (!cancelled) setError('Engine unreachable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchAgents();
    const interval = setInterval(fetchAgents, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-5">
        <h3 className="text-xs font-mono uppercase tracking-wider text-white/50 mb-4">Agent Status</h3>
        <div className="space-y-3 animate-pulse">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-10 rounded-lg bg-white/[0.02]" />
          ))}
        </div>
      </div>
    );
  }

  if (error || agents.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-5">
        <h3 className="text-xs font-mono uppercase tracking-wider text-white/50 mb-4">Agent Status</h3>
        <div className="text-center py-6 text-white/20 text-xs">
          <Bot size={20} className="mx-auto mb-2 opacity-50" />
          {error || 'No agents registered'}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-5">
      <h3 className="text-xs font-mono uppercase tracking-wider text-white/50 mb-4">
        Agent Status <span className="text-white/20 ml-1">({agents.length})</span>
      </h3>
      <div className="space-y-1.5">
        {agents.map((agent) => {
          const config = STATUS_CONFIG[agent.status] || STATUS_CONFIG.idle;
          const Icon = config.icon;
          return (
            <motion.div
              key={agent.agent_id || agent.name}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex items-center gap-3 p-2.5 rounded-lg ${config.bg} border border-white/[0.03] transition-colors hover:border-white/[0.08]`}
            >
              <Icon size={14} className={config.color} />
              <span className="text-xs text-white/80 flex-1 truncate font-medium">
                {agent.name}
              </span>
              <span className={`text-[10px] uppercase tracking-wider font-semibold ${config.color}`}>
                {agent.status}
              </span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}