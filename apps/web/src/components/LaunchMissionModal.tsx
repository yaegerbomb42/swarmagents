'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Rocket, Loader2, Check, AlertCircle, Zap, Brain, Globe, Code, FileSearch, Shield, Clipboard, Wand } from 'lucide-react';

interface LaunchMissionModalProps {
  open: boolean;
  onClose: () => void;
}

type Priority = 'high' | 'medium' | 'low';

const CAPABILITIES = [
  { id: 'code_generation', icon: Code, label: 'Code Gen' },
  { id: 'codebase_navigation', icon: FileSearch, label: 'Navigation' },
  { id: 'reasoning', icon: Brain, label: 'Reasoning' },
  { id: 'browser', icon: Globe, label: 'Browser' },
  { id: 'memory_lookup', icon: Clipboard, label: 'Memory' },
  { id: 'validation', icon: Shield, label: 'Validation' },
  { id: 'planning', icon: Wand, label: 'Planning' },
  { id: 'web_search', icon: Zap, label: 'Search' },
];

export default function LaunchMissionModal({ open, onClose }: LaunchMissionModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [capabilities, setCapabilities] = useState<string[]>(['code_generation']);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const toggleCap = (cap: string) => {
    setCapabilities(cs => cs.includes(cap) ? cs.filter(c => c !== cap) : [...cs, cap]);
  };

  const submit = async () => {
    if (!title.trim()) {
      setResult({ ok: false, msg: 'Title is required' });
      return;
    }
    setSubmitting(true);
    setResult(null);

    const priorityNum = priority === 'high' ? 9 : priority === 'medium' ? 5 : 2;

    const payload = {
      title: title.trim(),
      description: description.trim(),
      priority: priorityNum,
      requirements: capabilities,
      source: 'studio_ui',
      auto_decompose: true,
    };

    try {
      const ENGINE = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:8400';

      let success = false;
      let lastErr = '';

      const endpoints = [
        { url: `${ENGINE}/tasks/create`, label: 'engine' },
        { url: '/api/orchestrator/tasks', label: 'orchestrator' },
      ];

      for (const { url, label } of endpoints) {
        try {
          const body = label === 'orchestrator'
            ? { action: 'submit', ...payload }
            : payload;

          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            cache: 'no-store',
          });
          if (res.ok) {
            success = true;
            break;
          }
          lastErr = `${label}: ${res.status}`;
        } catch (e: any) {
          lastErr = `${label}: ${e.message}`;
        }
      }

      if (success) {
        setResult({ ok: true, msg: 'Mission submitted to swarm.' });
        setTimeout(() => {
          setTitle('');
          setDescription('');
          setResult(null);
          onClose();
        }, 1500);
      } else {
        setResult({ ok: false, msg: `Engine unreachable. Last error: ${lastErr}` });
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e.message || 'Submission failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/75 backdrop-blur-xl z-[9000] transition-all duration-500 ease-out"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed top-[10%] left-1/2 -translate-x-1/2 w-[540px] z-[9001] hologram-border-wrap rounded-2xl"
          >
            <div className="hologram-border-inner rounded-2xl shadow-2xl overflow-hidden border border-white/[0.04]">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-black/40">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shadow-lg shadow-cyan-500/30">
                    <Rocket size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-white">Launch New Mission</h2>
                    <p className="text-[11px] text-gray-500">Submit a task to the swarm</p>
                  </div>
                </div>
                <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/5">
                  <X size={18} />
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-5">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] font-bold text-gray-500 mb-2 block">
                    Mission Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Add GitHub OAuth provider to SwarmAgents"
                    className="w-full px-4 py-3 bg-white/[0.03] border border-white/10 rounded-xl text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-cyan-400/40 focus:ring-1 focus:ring-cyan-400/20 transition-all"
                    autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] font-bold text-gray-500 mb-2 block">
                    Description
                  </label>
                  <div className="phosphor-screen rounded-xl overflow-hidden">
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Optional: extra context, constraints, success criteria…"
                      rows={3}
                      className="relative z-10 w-full px-4 py-3 bg-black/60 border border-white/10 rounded-xl text-cyan-400 text-sm placeholder:text-cyan-800/60 focus:outline-none focus:border-cyan-400/40 focus:ring-1 focus:ring-cyan-400/20 transition-all resize-none font-mono"
                      onKeyDown={e => {
                        // Throttle keydown execution rate
                        const throttleKey = (globalThis as any).__last_modal_key || 0;
                        const now = Date.now();
                        if (now - throttleKey < 40) {
                          e.preventDefault();
                        } else {
                          (globalThis as any).__last_modal_key = now;
                        }
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] font-bold text-gray-500 mb-2 block">
                    Priority
                  </label>
                  <div className="flex gap-2">
                    {(['low', 'medium', 'high'] as Priority[]).map(p => (
                      <button
                        key={p}
                        onClick={() => setPriority(p)}
                        className={`flex-1 px-4 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-wide transition-all ${
                          priority === p
                            ? p === 'high'
                              ? 'bg-rose-500/15 text-rose-200 border border-rose-400/30 shadow-lg shadow-rose-500/10'
                              : p === 'medium'
                                ? 'bg-amber-500/15 text-amber-200 border border-amber-400/30 shadow-lg shadow-amber-500/10'
                                : 'bg-slate-500/15 text-slate-200 border border-slate-400/30 shadow-lg shadow-slate-500/10'
                            : 'bg-white/[0.03] text-gray-500 border border-white/5 hover:border-white/10 hover:text-gray-300'
                        }`}
                      >
                        <span className="mr-1.5">
                          {p === 'high' ? '🔥' : p === 'medium' ? '⚡' : '💤'}
                        </span>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] font-bold text-gray-500 mb-2 block">
                    Required Capabilities
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {CAPABILITIES.map(({ id, icon: Icon, label }) => (
                      <button
                        key={id}
                        onClick={() => toggleCap(id)}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium transition-all ${
                          capabilities.includes(id)
                            ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/30 shadow-sm shadow-cyan-500/10'
                            : 'bg-white/[0.03] text-gray-500 border border-white/5 hover:border-white/10 hover:text-gray-300'
                        }`}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {result && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex items-start gap-2.5 px-4 py-3 rounded-xl text-xs ${
                      result.ok
                        ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                        : 'bg-red-500/10 border border-red-500/20 text-red-300'
                    }`}
                  >
                    {result.ok ? <Check size={15} className="shrink-0 mt-0.5" /> : <AlertCircle size={15} className="shrink-0 mt-0.5" />}
                    <span>{result.msg}</span>
                  </motion.div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-800 bg-black/20">
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="px-5 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-all disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting || !title.trim()}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-cyan-500/20 to-teal-500/20 hover:from-cyan-500/30 hover:to-teal-500/30 disabled:from-gray-700/20 disabled:to-gray-700/20 disabled:cursor-not-allowed text-cyan-200 text-sm font-semibold rounded-xl border border-cyan-400/30 hover:border-cyan-400/50 disabled:border-gray-600/20 shadow-lg shadow-cyan-500/10 transition-all"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      Launching…
                    </>
                  ) : (
                    <>
                      <Rocket size={15} />
                      Launch Mission
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}