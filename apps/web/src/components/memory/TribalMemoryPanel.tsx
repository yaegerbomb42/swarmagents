'use client';

import { useEffect, useMemo, useState } from 'react';
import { Brain, Plus, Search, Sparkles, X } from 'lucide-react';
import {
  fetchTribalRules,
  fetchTribalStats,
  createTribalRule,
  deleteTribalRule,
  type TribalRule,
  type TribalStats,
} from '@/lib/tribal';
import TribalStatsHeader from './TribalStatsHeader';
import RuleCard from './RuleCard';

type Filter = 'all' | 'user' | 'learned' | 'agents_md';

export default function TribalMemoryPanel() {
  const [rules, setRules] = useState<TribalRule[]>([]);
  const [stats, setStats] = useState<TribalStats | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newRuleText, setNewRuleText] = useState('');
  const [newRuleSection, setNewRuleSection] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadData = () => {
    setLoading(true);
    setError(null);
    Promise.allSettled([fetchTribalRules(), fetchTribalStats()])
      .then(([rulesRes, statsRes]) => {
        if (rulesRes.status === 'fulfilled') {
          setRules(rulesRes.value.rules ?? []);
          setAvailable(rulesRes.value.available);
        } else {
          setError(rulesRes.reason?.message ?? 'failed to load rules');
        }
        if (statsRes.status === 'fulfilled') setStats(statsRes.value);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleText.trim() || isSubmitting) return;

    try {
      setIsSubmitting(true);
      const res = await createTribalRule({
        rule: newRuleText.trim(),
        section: newRuleSection.trim() || undefined,
        confidence: 0.95,
      });

      if (res.ok && res.rule) {
        setRules((prev) => [res.rule!, ...prev]);
        setShowAddModal(false);
        setNewRuleText('');
        setNewRuleSection('');
        if (stats) {
          setStats({
            ...stats,
            total_rules: stats.total_rules + 1,
            learned_rules: stats.learned_rules + 1,
          });
        }
      }
    } catch (err: any) {
      alert(`Failed to save rule: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Delete this rule from your cross-project swarm memory?')) return;
    try {
      await deleteTribalRule(ruleId);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      if (stats) {
        setStats({
          ...stats,
          total_rules: Math.max(0, stats.total_rules - 1),
          learned_rules: Math.max(0, stats.learned_rules - 1),
        });
      }
    } catch (err: any) {
      alert(`Failed to delete rule: ${err?.message || 'Unknown error'}`);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (filter === 'user' && !(r.source === 'user' || r.id.startsWith('usr-'))) return false;
      if (filter === 'learned' && r.source !== 'learned') return false;
      if (filter === 'agents_md' && r.source !== 'agents_md') return false;
      if (!q) return true;
      return (
        r.rule.toLowerCase().includes(q) ||
        (r.section ?? '').toLowerCase().includes(q) ||
        (r.source_task ?? '').toLowerCase().includes(q)
      );
    });
  }, [rules, query, filter]);

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-cyan-300" />
          <h2 className="text-lg font-semibold tracking-tight text-cyan-100">
            What the swarm learned
          </h2>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20 hover:border-cyan-400/50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Memory Rule
        </button>
      </div>

      <TribalStatsHeader stats={stats} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-100/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rules, sections, source tasks…"
            className="w-full rounded-lg border border-cyan-400/15 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-cyan-50 placeholder:text-cyan-100/25 focus:border-cyan-400/40 focus:outline-none"
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-cyan-400/15 bg-white/[0.03] p-1 overflow-x-auto">
          {(
            [
              { key: 'all', label: 'All' },
              { key: 'user', label: 'User Rules' },
              { key: 'learned', label: 'Learned' },
              { key: 'agents_md', label: 'AGENTS.md' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`rounded-md px-3 py-1 text-xs whitespace-nowrap transition-colors ${
                filter === item.key
                  ? 'bg-cyan-400/15 text-cyan-100 font-medium'
                  : 'text-cyan-100/45 hover:text-cyan-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-cyan-400/20 bg-[#0c0f17] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-cyan-400" />
                <h3 className="text-base font-semibold text-cyan-50">Add Cross-Project Swarm Rule</h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-cyan-100/40 hover:text-cyan-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-cyan-100/50 mb-4">
              This rule will be saved to your user memory and injected into agent prompts across every project and session.
            </p>
            <form onSubmit={handleAddRule} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-cyan-200/80 mb-1">
                  Rule Description *
                </label>
                <textarea
                  required
                  rows={3}
                  value={newRuleText}
                  onChange={(e) => setNewRuleText(e.target.value)}
                  placeholder="e.g. Always verify port availability before binding socket server..."
                  className="w-full rounded-lg border border-cyan-400/20 bg-white/[0.03] p-2.5 text-sm text-cyan-50 placeholder:text-cyan-100/25 focus:border-cyan-400/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-cyan-200/80 mb-1">
                  Section / Category (Optional)
                </label>
                <input
                  type="text"
                  value={newRuleSection}
                  onChange={(e) => setNewRuleSection(e.target.value)}
                  placeholder="e.g. Architecture, Networking, Auth"
                  className="w-full rounded-lg border border-cyan-400/20 bg-white/[0.03] p-2 text-sm text-cyan-50 placeholder:text-cyan-100/25 focus:border-cyan-400/50 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg border border-cyan-400/10 px-4 py-2 text-xs text-cyan-100/60 hover:text-cyan-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newRuleText.trim()}
                  className="rounded-lg bg-cyan-500/20 border border-cyan-400/40 px-4 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving…' : 'Save Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-950/20 p-5 text-sm text-cyan-200/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="h-5 w-5 text-cyan-400 shrink-0" />
            <div>
              <p className="font-medium text-cyan-100">Swarm Memory Standby</p>
              <p className="text-xs text-cyan-300/60 mt-0.5">
                The tribal memory engine is standing by. Rules will sync automatically as agents run tasks.
              </p>
            </div>
          </div>
          <button
            onClick={loadData}
            className="text-xs font-mono rounded-md border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-cyan-200 hover:bg-cyan-500/20 transition-colors ml-4 shrink-0"
          >
            Refresh
          </button>
        </div>
      )}

      {!error && loading && (
        <div className="rounded-xl border border-cyan-400/10 bg-white/[0.02] p-8 text-center text-sm text-cyan-100/40">
          Loading tribal memory…
        </div>
      )}

      {!error && !loading && visible.length === 0 && (
        <div className="rounded-xl border border-cyan-400/10 bg-white/[0.02] p-8 text-center">
          <Brain className="mx-auto h-8 w-8 text-cyan-100/20" />
          {available && rules.length === 0 ? (
            <>
              <p className="mt-3 text-sm font-medium text-cyan-100/70">No tribal rules yet.</p>
              <p className="mt-1 text-xs text-cyan-100/40">
                The swarm records a rule each time it discovers something durable about the
                codebase, or you can add your own custom cross-project rules using the button above.
              </p>
            </>
          ) : !available ? (
            <>
              <p className="mt-3 text-sm font-medium text-cyan-100/70">Tribal memory unavailable.</p>
              <p className="mt-1 text-xs text-cyan-100/40">
                The engine’s cognitive layer is disabled or failed to initialise. Enable
                COGNITIVE_TRIBAL on the engine to start accumulating swarm memory.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-cyan-100/50">No rules match this filter.</p>
          )}
        </div>
      )}

      {!error && !loading && visible.length > 0 && (
        <div className="grid gap-3">
          {visible.map((r) => (
            <RuleCard key={r.id} rule={r} onDelete={handleDeleteRule} />
          ))}
        </div>
      )}
    </section>
  );
}

