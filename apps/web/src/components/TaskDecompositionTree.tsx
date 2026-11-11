'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain, GitBranch, Zap, Activity, Clock, Users, Bot,
  Shield, Cpu, Network, CheckCircle, Loader2, AlertTriangle,
  Layers, Target, Sparkles, Play, ChevronDown, ChevronRight,
  RefreshCw, XCircle, Terminal, Eye, RotateCcw, ArrowUpRight,
  SkipForward,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────

interface DecomposedTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  priority: string;
  agent_class: string;
  depends_on: string[];
  result?: string;
  error?: string;
  progress?: number;
  agentId?: string;
  level?: number;
}

interface DecompositionResult {
  ok: boolean;
  originalTask: string;
  subtasks: DecomposedTask[];
  count: number;
  estimated_minutes?: number;
  complexity?: string;
  model?: string;
  fallback?: boolean;
}

// ─── Status helpers ────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'border-emerald-500/40 bg-emerald-500/[0.03] shadow-[0_0_15px_rgba(16,185,129,0.08)] hover:border-emerald-500/60 hover:shadow-[0_0_20px_rgba(16,185,129,0.18)] text-emerald-300/90 transition-all duration-300',
  running: 'border-cyan-400/50 bg-[#070e28]/70 shadow-[0_0_25px_rgba(6,182,212,0.18)] hover:border-cyan-400/80 hover:shadow-[0_0_30px_rgba(6,182,212,0.28)] text-cyan-100 transition-all duration-300 ring-1 ring-cyan-500/30',
  pending: 'border-white/[0.06] bg-[#02020a]/40 shadow-[0_0_10px_rgba(255,255,255,0.01)] hover:border-white/20 text-white/50 transition-all duration-300',
  failed: 'border-red-500/40 bg-red-950/[0.04] shadow-[0_0_20px_rgba(239,68,68,0.15)] hover:border-red-500/60 hover:shadow-[0_0_25px_rgba(239,68,68,0.25)] text-red-300 transition-all duration-300 ring-1 ring-red-500/20',
  blocked: 'border-amber-500/40 bg-amber-950/[0.04] shadow-[0_0_15px_rgba(245,158,11,0.1)] hover:border-amber-500/60 hover:shadow-[0_0_20px_rgba(245,158,11,0.2)] text-amber-300 transition-all duration-300',
};

const TAG_CLASSES: Record<string, string> = {
  orchestrator: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/35 shadow-[0_0_10px_rgba(6,182,212,0.05)]',
  architect: 'bg-blue-500/10 text-blue-300 border-blue-500/35',
  backend: 'bg-amber-500/10 text-amber-300 border-amber-500/35',
  frontend: 'bg-purple-500/10 text-purple-300 border-purple-500/35',
  qa: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/35',
  specialist: 'bg-violet-500/10 text-violet-300 border-violet-500/35',
  grunt: 'bg-white/[0.03] text-white/40 border-white/[0.08]',
};

const TAG_ICONS: Record<string, React.ElementType> = {
  orchestrator: Brain,
  architect: Layers,
  backend: Cpu,
  frontend: Zap,
  qa: CheckCircle,
  specialist: Target,
  grunt: Bot,
};

// ─── SVG Connection Builder ─────────────────────────────────────────

function buildTreeConnections(
  svg: SVGSVGElement,
  container: HTMLElement,
  tasks: DecomposedTask[],
  hoveredNode: DecomposedTask | null,
) {
  svg.innerHTML = '';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<filter id="glow-line"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  svg.appendChild(defs);

  const connColor = (id: string, isHighlighted: boolean) => {
    if (isHighlighted) return { stroke: '#f59e0b', glow: 'rgba(245,158,11,0.4)' }; // soft golden flow for active path
    const t = tasks.find(x => x.id === id);
    if (!t) return { stroke: '#00f5ff', glow: 'rgba(0,245,255,0.15)' };
    if (t.status === 'completed') return { stroke: '#10b981', glow: 'rgba(16,185,129,0.25)' };
    if (t.status === 'running') return { stroke: '#06b6d4', glow: 'rgba(6,182,212,0.3)' };
    if (t.status === 'failed') return { stroke: '#ef4444', glow: 'rgba(239,68,68,0.25)' };
    return { stroke: '#3b82f6', glow: 'rgba(59,130,246,0.15)' };
  };

  tasks.forEach(task => {
    task.depends_on.forEach(depId => {
      const fromEl = document.getElementById(`node-${depId}`);
      const toEl = document.getElementById(`node-${task.id}`);
      if (!fromEl || !toEl) return;

      const cr = container.getBoundingClientRect();
      const fr = fromEl.getBoundingClientRect();
      const tr = toEl.getBoundingClientRect();

      const x1 = fr.left - cr.left + fr.width / 2;
      const y1 = fr.top - cr.top + fr.height;
      const x2 = tr.left - cr.left + tr.width / 2;
      const y2 = tr.top - cr.top;
      const cy1 = y1 + (y2 - y1) * 0.45;
      const cy2 = y2 - (y2 - y1) * 0.45;

      const d = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
      
      const isPathRelated = !hoveredNode || 
        (hoveredNode.id === task.id && depId === hoveredNode.depends_on.find(x => x === depId)) ||
        (hoveredNode.id === depId && task.depends_on.includes(hoveredNode.id));

      const c = connColor(depId, hoveredNode !== null && isPathRelated);
      const pathId = `path-${depId}-${task.id}`;

      const opacGlow = hoveredNode ? (isPathRelated ? 0.55 : 0.05) : 0.25;
      const opacSharp = hoveredNode ? (isPathRelated ? 1.0 : 0.1) : 0.7;
      const strokeWidthGlow = isPathRelated && hoveredNode ? '7' : '5';
      const strokeWidthSharp = isPathRelated && hoveredNode ? '2.5' : '1.5';

      // Glowing blurred background path for fiber-optic effect
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      g.setAttribute('d', d); g.setAttribute('fill', 'none');
      g.setAttribute('stroke', c.stroke); g.setAttribute('stroke-width', strokeWidthGlow);
      g.setAttribute('opacity', String(opacGlow)); g.style.filter = 'url(#glow-line)';
      svg.appendChild(g);

      // Sharp central connection path
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('id', pathId); p.setAttribute('d', d);
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', c.stroke);
      p.setAttribute('stroke-width', strokeWidthSharp); p.setAttribute('opacity', String(opacSharp));
      svg.appendChild(p);

      // Animate flowing pulses through the network path
      if ((task.status === 'running' || task.status === 'pending') && (!hoveredNode || isPathRelated)) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', isPathRelated && hoveredNode ? '4' : '3'); 
        dot.setAttribute('fill', c.stroke);
        dot.style.filter = `drop-shadow(0 0 6px ${c.stroke})`;
        
        const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
        anim.setAttribute('dur', `${1.2 + Math.random() * 1.5}s`);
        anim.setAttribute('repeatCount', 'indefinite');
        anim.setAttribute('keyPoints', '0;1'); anim.setAttribute('keyTimes', '0;1');
        anim.setAttribute('calcMode', 'linear');
        anim.setAttribute('begin', `${Math.random() * 1.5}s`);
        
        const mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
        mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', `#${pathId}`);
        anim.appendChild(mpath); dot.appendChild(anim); svg.appendChild(dot);
      }
    });
  });
}

// ─── Task Graph Builder ─────────────────────────────────────────────

function buildLevels(tasks: DecomposedTask[]): DecomposedTask[][] {
  const levels: DecomposedTask[][] = [];
  const remaining = new Map(tasks.map(t => [t.id, { ...t }]));
  const placed = new Set<string>();

  while (remaining.size > 0) {
    const level: DecomposedTask[] = [];
    for (const [id, task] of remaining) {
      if (task.depends_on.every(d => placed.has(d))) {
        level.push(task);
      }
    }
    if (level.length === 0) {
      levels.push([...remaining.values()]);
      break;
    }
    level.forEach(t => { placed.add(t.id); remaining.delete(t.id); });
    levels.push(level);
  }

  return levels;
}

// Check if a task's dependencies are all completed
function depsMet(task: DecomposedTask, tasks: DecomposedTask[]): boolean {
  return task.depends_on.every(depId => {
    const dep = tasks.find(t => t.id === depId);
    return dep?.status === 'completed';
  });
}

// ─── Main Component ─────────────────────────────────────────────────

// Cycle detection DFS logic (Prompt 2)
function wouldCreateCycle(tasks: DecomposedTask[], sourceId: string, targetId: string): boolean {
  const visited = new Set<string>();
  function dfs(currentId: string): boolean {
    if (currentId === targetId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const node = tasks.find(t => t.id === currentId);
    if (!node) return false;
    for (const depId of node.depends_on) {
      if (dfs(depId)) return true;
    }
    return false;
  }
  return dfs(sourceId);
}

export default function TaskDecompositionTree() {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [tasks, setTasks] = useState<DecomposedTask[]>([]);
  const [rootTask, setRootTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uptime, setUptime] = useState(0);
  const [selectedNode, setSelectedNode] = useState<DecomposedTask | null>(null);
  const [hoveredNode, setHoveredNode] = useState<DecomposedTask | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [completionTime, setCompletionTime] = useState<number | null>(null);

  // Drag states for link creation
  const [dragStartNode, setDragStartNode] = useState<string | null>(null);
  const [dragCurrentCoords, setDragCurrentCoords] = useState<{ x: number; y: number } | null>(null);
  const [errorNodeId, setErrorNodeId] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Mouse drag global handlers
  useEffect(() => {
    if (!dragStartNode) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDragCurrentCoords({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };
    const handleMouseUp = () => {
      setDragStartNode(null);
      setDragCurrentCoords(null);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragStartNode]);

  const handleLinkNodes = (sourceId: string, targetId: string) => {
    if (wouldCreateCycle(tasks, sourceId, targetId)) {
      setError(`Cyclic dependency warning: linking ${sourceId} to ${targetId} creates an infinite loop.`);
      setErrorNodeId(targetId);
      setTimeout(() => setErrorNodeId(null), 800);
      return;
    }
    setTasks(prev => prev.map(t =>
      t.id === targetId
        ? { ...t, depends_on: [...(t.depends_on || []), sourceId], status: t.status === 'completed' ? 'completed' : 'blocked' }
        : t
    ));
  };

  const getPortCoords = (nodeId: string) => {
    const el = document.getElementById(`node-${nodeId}`);
    if (!el || !containerRef.current) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const crect = containerRef.current.getBoundingClientRect();
    return {
      x: rect.left - crect.left + rect.width / 2,
      y: rect.bottom - crect.top
    };
  };


  // Uptime counter
  useEffect(() => {
    const t = setInterval(() => setUptime(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const formatUptime = (s: number) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };

  // ─── Execute a single task via SSE ─────────────────────────

  const executeTask = useCallback(async (task: DecomposedTask) => {
    // Mark task as running
    setTasks(prev => prev.map(t =>
      t.id === task.id
        ? { ...t, status: 'running', progress: 0, error: undefined }
        : t
    ));

    const abortController = new AbortController();
    abortControllersRef.current.set(task.id, abortController);

    const context = `Task: ${task.title}\nDescription: ${task.description}\nPriority: ${task.priority}`;

    try {
      const res = await fetch('/api/agent/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: task.title,
          context,
          taskId: task.id,
          maxRetries: 3,
          maxSteps: 20,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`Execute API returned ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'step' || currentEvent === 'started') {
                setTasks(prev => prev.map(t => {
                  if (t.id !== task.id) return t;
                  const step = (data as { step?: number }).step ?? 0;
                  const maxSteps = 20;
                  const progress = Math.min(95, Math.round((step / maxSteps) * 100));
                  return { ...t, progress: Math.max(t.progress || 0, progress) };
                }));
              }
              if (currentEvent === 'completed') {
                const d = data as { finalResult?: string; status?: string };
                setTasks(prev => prev.map(t =>
                  t.id === task.id
                    ? { ...t, status: 'completed', progress: 100, result: d.finalResult || 'Completed' }
                    : t
                ));
              }
              if (currentEvent === 'error') {
                const d = data as { error?: string };
                setTasks(prev => prev.map(t =>
                  t.id === task.id
                    ? { ...t, status: 'failed', error: d.error || 'Execution error' }
                    : t
                ));
              }
            } catch { /* skip malformed JSON */ }
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setTasks(prev => prev.map(t =>
        t.id === task.id
          ? { ...t, status: 'failed', error: e?.message || 'Execution failed' }
          : t
      ));
    } finally {
      abortControllersRef.current.delete(task.id);
    }
  }, []);

  // ─── Auto-advance: find ready tasks and execute ────────────

  useEffect(() => {
    if (tasks.length === 0) return;

    const ready = tasks.filter(t =>
      t.status === 'pending' && depsMet(t, tasks)
    );

    if (ready.length > 0) {
      for (const task of ready) {
        executeTask(task);
      }
    }
  }, [tasks, executeTask]);

  // ─── Recalculate dependency statuses ───────────────────────

  useEffect(() => {
    setTasks(prev => prev.map(t => {
      if (t.status !== 'pending' && t.status !== 'blocked') return t;
      const met = depsMet(t, prev);
      return { ...t, status: met ? 'pending' : 'blocked' };
    }));
  }, [tasks.map(t => t.status).join(',')]);

  // ─── Set completion time when all done ─────────────────────

  useEffect(() => {
    if (tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'failed')) {
      setCompletionTime(Date.now());
    }
  }, [tasks]);

  // ─── Redraw SVG when tasks change or hoveredNode updates ────

  useEffect(() => {
    setTimeout(() => {
      if (svgRef.current && containerRef.current) {
        buildTreeConnections(svgRef.current, containerRef.current, tasks, hoveredNode);
      }
    }, 50);
  }, [tasks, hoveredNode]);

  useEffect(() => {
    const h = () => setTimeout(() => {
      if (svgRef.current && containerRef.current) {
        buildTreeConnections(svgRef.current, containerRef.current, tasks, hoveredNode);
      }
    }, 100);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [tasks, hoveredNode]);

  // ─── Submit task for decomposition ─────────────────────────

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setSelectedNode(null);
    setCompletionTime(null);
    setStartTime(Date.now());

    // Abort any running executions
    for (const [id, ctrl] of abortControllersRef.current) {
      ctrl.abort();
    }
    abortControllersRef.current.clear();

    try {
      const decompRes = await fetch('/api/tasks/decompose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: text }),
      });
      const decompData: DecompositionResult = await decompRes.json();
      if (!decompData.ok || !decompData.subtasks?.length) {
        throw new Error((decompData as any).error || 'Decomposition returned no subtasks');
      }

      const newTasks: DecomposedTask[] = decompData.subtasks.map(st => ({
        ...st,
        progress: 0,
      }));

      setRootTask(decompData.originalTask);
      setTasks(newTasks);
    } catch (e: any) {
      setError(e?.message || 'Failed to decompose task');
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  // ─── Retry failed tasks ────────────────────────────────────

  const handleRetry = useCallback((taskId: string) => {
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: 'pending', error: undefined, progress: 0 } : t
    ));
  }, []);

  // ─── Reset all ────────────────────────────────────────────

  const handleReset = useCallback(() => {
    for (const [id, ctrl] of abortControllersRef.current) {
      ctrl.abort();
    }
    abortControllersRef.current.clear();
    setTasks([]);
    setRootTask('');
    setSelectedNode(null);
    setCompletionTime(null);
    setStartTime(null);
  }, []);

  const levels = buildLevels(tasks);
  const maxLevel = levels.length;

  const completed = tasks.filter(t => t.status === 'completed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const pending = tasks.filter(t => t.status === 'pending').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const totalProgress = tasks.length > 0
    ? Math.round(tasks.reduce((s, t) => s + (t.progress || 0), 0) / tasks.length)
    : 0;
  const elapsed = startTime && completionTime
    ? Math.round((completionTime - startTime) / 1000)
    : startTime
    ? Math.round((Date.now() - startTime) / 1000)
    : 0;

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-0">
      {/* Input bar */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
          <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-cyan-500/60">Decompose & Execute Pipeline</span>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
        </div>
        <div className="relative group">
          <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 opacity-0 group-focus-within:opacity-100 transition-opacity blur-xl" />
          <div className="relative flex items-center gap-0 rounded-xl border border-white/[0.08] bg-black/60 backdrop-blur-xl overflow-hidden shadow-2xl shadow-black/50 transition-all focus-within:border-cyan-400/30 focus-within:shadow-cyan-500/5">
            <div className="flex items-center pl-4 text-cyan-500/50">
              <GitBranch size={14} />
            </div>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
              placeholder="Describe what you want the swarm to build or do..."
              className="flex-1 bg-transparent px-3 py-3 text-sm text-white/80 placeholder-white/20 outline-none font-mono resize-none"
              rows={1}
            />
            <button
              onClick={handleSubmit}
              disabled={sending || !input.trim()}
              className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-black text-xs font-bold tracking-wider uppercase hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {sending ? 'Decomposing...' : 'Decompose'}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-2 px-4 py-2 mb-4 rounded-lg border border-red-500/20 bg-red-500/[0.04]"
          >
            <AlertTriangle size={12} className="text-red-400 flex-shrink-0" />
            <span className="text-[11px] text-red-400/80">{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-400/40 hover:text-red-400/70">
              <XCircle size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state */}
      {tasks.length === 0 && !sending && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-20 text-center"
        >
          {/* Concentric rotating radar rings (Prompt 9) */}
          <div className="relative w-24 h-24 mb-6 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-dashed border-cyan-500/20 animate-spin-slow" />
            <div className="absolute w-16 h-16 rounded-full border border-dashed border-purple-500/20 animate-spin-reverse-slow" />
            <div className="absolute w-8 h-8 rounded-full border border-cyan-500/10" />
            <div className="absolute w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)] animate-pulse" />
            <Brain size={24} className="text-cyan-400/80 animate-pulse relative z-10" />
          </div>

          <h3 className="text-sm font-semibold text-white/40 mb-2">Task Decomposition Pipeline</h3>
          <p className="text-[11px] text-white/20 max-w-md leading-relaxed">
            Describe a task and the engine will decompose it into a DAG of subtasks using DeepSeek v4 Flash,
            then auto-execute each subtask via the relentless execution engine. Completed tasks cascade to
            unlock downstream work — all dependencies respected automatically.
          </p>
          <div className="flex items-center gap-6 mt-6 text-[9px] text-white/15 font-mono uppercase tracking-wider">
            <span>LLM Decomposes</span>
            <ArrowUpRight size={10} />
            <span>Auto-Execute Wave</span>
            <ArrowUpRight size={10} />
            <span>Merge Results</span>
          </div>
        </motion.div>
      )}

      {/* Active decomposition */}
      {tasks.length > 0 && (
        <>
          {/* Stats bar */}
          <div className="flex items-center gap-4 px-3 py-2 mb-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
            <span className="text-[10px] font-mono text-white/40 truncate flex-1">
              <span className="text-cyan-400/70">{rootTask}</span>
            </span>
            <div className="flex items-center gap-3 text-[10px]">
              {running > 0 && (
                <span className="flex items-center gap-1 text-cyan-400/60">
                  <Loader2 size={10} className="animate-spin" />
                  {running} running
                </span>
              )}
              <span className="text-emerald-400/60">{completed} done</span>
              {pending > 0 && <span className="text-white/30">{pending} pending</span>}
              {blocked > 0 && <span className="text-amber-400/60">{blocked} blocked</span>}
              {failed > 0 && <span className="text-red-400/60">{failed} failed</span>}
              <span className="text-white/20">|</span>
              <span className="text-cyan-500/30 font-mono">{tasks.length} nodes</span>
              <span className="text-white/10 font-mono">{formatElapsed(elapsed)}</span>
            </div>
            <button
              onClick={handleReset}
              className="flex items-center gap-1 px-2 py-1 rounded text-[9px] text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors"
            >
              <RotateCcw size={10} />
              Reset
            </button>
          </div>

          {/* Main grid */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-4 flex-1 min-h-0">
            {/* Tree */}
            <div
              ref={containerRef}
              className="relative rounded-xl border border-white/[0.04] bg-[#06061a]/50 p-6 overflow-auto min-h-[500px]"
            >
              {/* Cyber mesh grid background (Prompt 5) */}
              <div className="absolute inset-0 cyber-grid-overlay pointer-events-none z-0" />
              <svg ref={svgRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />

              {/* Dynamic Connection Drag Bezier Path (Prompt 2) */}
              {dragStartNode && dragCurrentCoords && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-30">
                  <path
                    d={`M ${getPortCoords(dragStartNode).x} ${getPortCoords(dragStartNode).y} C ${getPortCoords(dragStartNode).x} ${(getPortCoords(dragStartNode).y + dragCurrentCoords.y) / 2}, ${dragCurrentCoords.x} ${(getPortCoords(dragStartNode).y + dragCurrentCoords.y) / 2}, ${dragCurrentCoords.x} ${dragCurrentCoords.y}`}
                    fill="none"
                    stroke="#00BFFF"
                    strokeWidth="2"
                    strokeDasharray="5 3"
                    className="animate-pulse"
                  />
                </svg>
              )}

              <div className="relative z-20 space-y-4">
                {levels.map((level, li) => (
                  <div key={li} className="relative">
                    <div className="flex items-center gap-1.5 justify-center mb-2">
                      <span className="text-[8px] font-mono uppercase tracking-[0.15em] text-white/[0.08]">
                        Level {li + 1}
                      </span>
                    </div>
                    <div className="flex items-center justify-center gap-4 flex-wrap">
                      {level.map((task, idx) => {
                        const StatusIcon = TAG_ICONS[task.agent_class] || GitBranch;
                        const isRunning = task.status === 'running';
                        const isDone = task.status === 'completed';
                        const isFailed = task.status === 'failed';
                        const isBlocked = task.status === 'blocked';
                        const isOrch = task.agent_class === 'orchestrator';

                        const isHoveredRelated = !hoveredNode || 
                          hoveredNode.id === task.id ||
                          hoveredNode.depends_on.includes(task.id) ||
                          task.depends_on.includes(hoveredNode.id);

                        const isShake = errorNodeId === task.id;

                        return (
                          <motion.div
                            key={task.id}
                            id={`node-${task.id}`}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ 
                              opacity: 1, 
                              scale: isShake ? [1, 0.94, 1.06, 0.94, 1.06, 1] : 1,
                              x: isShake ? [0, -6, 6, -6, 6, 0] : 0
                            }}
                            transition={{ 
                              delay: isShake ? 0 : idx * 0.04 + li * 0.08,
                              duration: isShake ? 0.4 : 0.3
                            }}
                            className={`
                              relative rounded-xl border backdrop-blur-sm p-3 cursor-pointer
                              transition-all duration-300 min-w-[170px] max-w-[210px]
                              hover:-translate-y-0.5 hover:shadow-lg
                              ${STATUS_COLORS[task.status]}
                              ${isOrch ? 'min-w-[230px] p-4 border-cyan-500/30 bg-cyan-500/[0.03] shadow-[0_0_20px_rgba(0,245,255,0.08)]' : ''}
                              ${isRunning ? 'ring-1 ring-cyan-500/20' : ''}
                              ${isFailed ? 'ring-1 ring-red-500/20' : ''}
                              ${isShake ? 'ring-2 ring-red-500 border-red-500 bg-red-950/20 shadow-[0_0_25px_rgba(239,68,68,0.4)]' : ''}
                              ${selectedNode?.id === task.id ? 'ring-2 ring-cyan-400/40' : ''}
                              ${hoveredNode && hoveredNode.id === task.id ? 'shadow-[0_0_20px_rgba(245,158,11,0.25)] border-amber-500/40' : ''}
                              ${isHoveredRelated ? 'opacity-100' : 'opacity-25'}
                            `}
                            onClick={() => setSelectedNode(selectedNode?.id === task.id ? null : task)}
                            onMouseEnter={() => setHoveredNode(task)}
                            onMouseLeave={() => setHoveredNode(null)}
                            onMouseUp={() => {
                              if (dragStartNode && dragStartNode !== task.id) {
                                handleLinkNodes(dragStartNode, task.id);
                              }
                            }}
                          >
                            {/* Scanning line for running nodes (Prompt 4) */}
                            {isRunning && (
                              <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none z-0">
                                <div className="w-full h-1/2 bg-gradient-to-b from-transparent via-cyan-500/10 to-transparent animate-scan-line" />
                              </div>
                            )}
                            {/* Header */}
                            <div className="flex items-start justify-between gap-2 mb-1.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <StatusIcon
                                  size={isOrch ? 16 : 12}
                                  className={`flex-shrink-0 ${
                                    isDone ? 'text-emerald-400' : isFailed ? 'text-red-400' : isRunning ? 'text-cyan-400' : 'text-white/20'
                                  }`}
                                />
                                <span className={`${isOrch ? 'text-xs' : 'text-[10px]'} font-semibold text-white/80 truncate leading-tight`}>
                                  {task.title}
                                </span>
                              </div>
                            </div>

                            {/* Tag + Status */}
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-[8px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider ${TAG_CLASSES[task.agent_class] || 'bg-white/[0.05] text-white/30'}`}>
                                {task.agent_class}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {isRunning && <div className="w-2 h-2 rounded-full border border-cyan-400 border-t-transparent animate-spin" />}
                                {isDone && <CheckCircle size={9} className="text-emerald-400" />}
                                {isFailed && <XCircle size={9} className="text-red-400" />}
                                {isBlocked && <AlertTriangle size={9} className="text-amber-400" />}
                                <span className={`text-[8px] font-mono ${
                                  isDone ? 'text-emerald-400/60' : isFailed ? 'text-red-400/60' : isRunning ? 'text-cyan-400/60' : isBlocked ? 'text-amber-400/60' : 'text-white/20'
                                }`}>
                                  {isDone ? 'DONE' : isFailed ? 'FAILED' : isBlocked ? 'BLOCKED' : isRunning ? `${task.progress ?? 0}%` : 'PENDING'}
                                </span>
                              </div>
                            </div>

                            {/* Progress bar */}
                            {(isRunning || isDone) && (
                              <div className="mt-2 h-1 rounded-full bg-white/[0.05] overflow-hidden">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: `${isDone ? 100 : task.progress || 0}%` }}
                                  className={`h-full rounded-full ${
                                    isDone ? 'bg-emerald-500' : 'bg-gradient-to-r from-cyan-500 to-blue-500'
                                  }`}
                                  transition={{ duration: 0.8, ease: 'easeOut' }}
                                />
                              </div>
                            )}

                            {/* Failed — show retry button */}
                            {isFailed && (
                              <button
                                onClick={e => { e.stopPropagation(); handleRetry(task.id); }}
                                className="mt-2 w-full flex items-center justify-center gap-1 py-1 rounded text-[8px] bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 transition-colors"
                              >
                                <RefreshCw size={8} /> Retry
                              </button>
                            )}

                            {/* Drag Port Sockets (Prompt 2) */}
                            <div
                              className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-cyan-500 border-2 border-[#06061a] hover:scale-125 hover:bg-amber-400 transition-all cursor-crosshair z-30 shadow-[0_0_8px_rgba(6,182,212,0.8)]"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setDragStartNode(task.id);
                                const rect = containerRef.current?.getBoundingClientRect();
                                if (rect) {
                                  setDragCurrentCoords({
                                    x: e.clientX - rect.left,
                                    y: e.clientY - rect.top
                                  });
                                }
                              }}
                            />
                          </motion.div>
                        );
                      })}
                    </div>

                    {/* Level connector */}
                    {li < maxLevel - 1 && (
                      <div className="flex justify-center my-1.5">
                        <div className="w-px h-4 bg-gradient-to-b from-cyan-500/15 to-transparent" />
                      </div>
                    )}
                  </div>
                ))}

                {/* Final output — all tasks done */}
                {completed === tasks.length && tasks.length > 0 && (
                  <div className="flex justify-center pt-3">
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.3, type: 'spring' }}
                      className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-5 min-w-[300px] text-center shadow-[0_0_40px_rgba(0,255,159,0.08)]"
                    >
                      <Sparkles size={24} className="mx-auto text-emerald-400 mb-2" />
                      <div className="text-[9px] font-mono uppercase tracking-[0.25em] text-emerald-500/60 mb-1">Pipeline Complete</div>
                      <div className="text-sm font-bold text-white/90 mb-1">DELIVERABLE ASSEMBLED</div>
                      <div className="text-[10px] text-emerald-400/50">
                        {tasks.length} tasks in {formatElapsed(elapsed)}
                      </div>
                      <button
                        onClick={handleReset}
                        className="mt-3 flex items-center gap-1.5 mx-auto px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[9px] text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                      >
                        <RotateCcw size={10} /> New Task
                      </button>
                    </motion.div>
                  </div>
                )}

                {/* Partial completion — failed but not all attempted */}
                {failed > 0 && completed + failed === tasks.length && completed > 0 && (
                  <div className="flex justify-center pt-3">
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 min-w-[280px] text-center"
                    >
                      <AlertTriangle size={20} className="mx-auto text-amber-400 mb-2" />
                      <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-amber-500/60 mb-1">Partial Completion</div>
                      <div className="text-xs text-white/60 mb-1">
                        {completed}/{tasks.length} tasks completed
                      </div>
                      <div className="text-[9px] text-amber-400/50">
                        {failed} task{failed > 1 ? 's' : ''} failed — retry above or reset
                      </div>
                    </motion.div>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-3 overflow-y-auto max-h-[calc(100vh-200px)]">
              {/* Selected Node Detail */}
              {selectedNode ? (
                <div className="rounded-xl border border-cyan-500/20 bg-[#06061a]/80 backdrop-blur-sm p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-cyan-500/60">Task Detail</span>
                    <button onClick={() => setSelectedNode(null)} className="text-white/20 hover:text-white/50">
                      <XCircle size={11} />
                    </button>
                  </div>
                  <div className="text-[11px] font-semibold text-white/80 mb-1">{selectedNode.title}</div>
                  <div className="text-[9px] text-white/40 mb-2">{selectedNode.description || 'No description'}</div>
                  <div className="grid grid-cols-2 gap-2 text-[9px]">
                    <div>
                      <span className="text-white/30">Status: </span>
                      <span className={`font-semibold ${
                        selectedNode.status === 'completed' ? 'text-emerald-400' :
                        selectedNode.status === 'running' ? 'text-cyan-400' :
                        selectedNode.status === 'failed' ? 'text-red-400' : 'text-white/50'
                      }`}>{selectedNode.status.toUpperCase()}</span>
                    </div>
                    <div>
                      <span className="text-white/30">Priority: </span>
                      <span className="text-white/60 font-semibold">{selectedNode.priority.toUpperCase()}</span>
                    </div>
                    <div>
                      <span className="text-white/30">Agent: </span>
                      <span className="text-white/60">{selectedNode.agent_class}</span>
                    </div>
                    <div>
                      <span className="text-white/30">Deps: </span>
                      <span className="text-white/60">{selectedNode.depends_on.length || 'none'}</span>
                    </div>
                  </div>
                  {selectedNode.result && (
                    <div className="mt-2 p-2 rounded bg-white/[0.03] border border-white/[0.06]">
                      <div className="text-[8px] uppercase tracking-wider text-emerald-400/50 mb-1">Result</div>
                      <div className="text-[9px] text-white/50 leading-relaxed max-h-24 overflow-y-auto">{selectedNode.result}</div>
                    </div>
                  )}
                  {selectedNode.error && (
                    <div className="mt-2 p-2 rounded bg-red-500/[0.05] border border-red-500/10">
                      <div className="text-[8px] uppercase tracking-wider text-red-400/50 mb-1">Error</div>
                      <div className="text-[9px] text-red-400/60">{selectedNode.error}</div>
                      <button
                        onClick={() => handleRetry(selectedNode.id)}
                        className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded text-[8px] bg-red-500/10 border border-red-500/20 text-red-400/70 hover:bg-red-500/20 transition-colors"
                      >
                        <RefreshCw size={8} /> Retry Task
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Overall progress */}
              {tasks.length > 0 && (
                <div className="rounded-xl border border-white/[0.04] bg-[#06061a]/80 backdrop-blur-sm p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Activity size={11} className="text-cyan-500/70" />
                    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-cyan-500/60 flex-1">Pipeline Progress</span>
                    <span className="text-[9px] font-mono text-white/20">{totalProgress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden mb-3">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${totalProgress}%` }}
                      className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-blue-500 to-emerald-500"
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                    />
                  </div>
                  {[
                    { label: 'Completed', value: String(completed), color: 'from-emerald-500 to-emerald-400', pct: tasks.length ? (completed / tasks.length) * 100 : 0 },
                    { label: 'Running', value: String(running), color: 'from-cyan-500 to-blue-500', pct: tasks.length ? (running / tasks.length) * 100 : 0 },
                    { label: 'Pending', value: String(pending), color: 'from-white/30 to-white/10', pct: tasks.length ? (pending / tasks.length) * 100 : 0 },
                    { label: 'Blocked', value: String(blocked), color: 'from-amber-500 to-yellow-500', pct: tasks.length ? (blocked / tasks.length) * 100 : 0 },
                    { label: 'Failed', value: String(failed), color: 'from-red-500 to-orange-500', pct: tasks.length ? (failed / tasks.length) * 100 : 0 },
                  ].map((m, i) => (
                    <div key={i} className="mb-2 last:mb-0">
                      <div className="flex justify-between items-center mb-0.5">
                        <span className="text-[8px] text-white/40 tracking-wider">{m.label}</span>
                        <span className="text-[10px] font-bold text-white/70 font-mono">{m.value}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/[0.02] border border-white/[0.05] overflow-hidden relative">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${m.pct}%` }}
                          className={`h-full rounded-full bg-gradient-to-r ${m.color} relative`}
                          transition={{ duration: 0.6, ease: 'easeOut' }}
                        >
                          {m.pct > 0 && (
                            <div className="absolute right-0 top-0 h-full w-1 bg-white rounded-full shadow-[0_0_8px_#fff]" />
                          )}
                        </motion.div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Timeline */}
              {tasks.length > 0 && (
                <div className="rounded-xl border border-white/[0.04] bg-[#06061a]/80 backdrop-blur-sm p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Clock size={11} className="text-cyan-500/70" />
                    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-cyan-500/60 flex-1">Timeline</span>
                  </div>
                  <div className="space-y-1">
                    {levels.map((level, li) => {
                      const levelComplete = level.every(t => t.status === 'completed');
                      const levelRunning = level.some(t => t.status === 'running' || t.status === 'pending');
                      return (
                        <div key={li} className="flex items-center gap-2 py-1">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            levelComplete ? 'bg-emerald-500 shadow-[0_0_4px_rgba(0,255,159,0.5)]' :
                            levelRunning ? 'bg-cyan-500 animate-pulse' : 'bg-white/[0.1]'
                          }`} />
                          <span className="text-[9px] text-white/40 flex-1">Level {li + 1}</span>
                          <span className={`text-[8px] font-mono ${
                            levelComplete ? 'text-emerald-400/60' : levelRunning ? 'text-cyan-400/60' : 'text-white/20'
                          }`}>
                            {level.filter(t => t.status === 'completed').length}/{level.length}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Agents legend */}
              {tasks.length > 0 && (
                <div className="rounded-xl border border-white/[0.04] bg-[#06061a]/80 backdrop-blur-sm p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <Users size={11} className="text-cyan-500/70" />
                    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-cyan-500/60 flex-1">Agent Classes</span>
                  </div>
                  <div className="space-y-1">
                    {Object.entries(TAG_CLASSES).map(([cls, clsClass]) => {
                      const count = tasks.filter(t => t.agent_class === cls).length;
                      if (count === 0) return null;
                      const Icon = TAG_ICONS[cls] || Bot;
                      return (
                        <div key={cls} className="flex items-center gap-2 px-2 py-1 rounded">
                          <Icon size={10} className="text-white/30" />
                          <span className={`text-[8px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider ${clsClass}`}>
                            {cls}
                          </span>
                          <span className="text-[9px] text-white/30 font-mono ml-auto">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* DAG structure */}
              {tasks.length > 0 && (
                <div className="rounded-xl border border-white/[0.04] bg-[#06061a]/80 backdrop-blur-sm p-3">
                  <div className="flex items-center gap-2 mb-2.5">
                    <GitBranch size={11} className="text-cyan-500/70" />
                    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-cyan-500/60 flex-1">DAG</span>
                  </div>
                  <div className="space-y-1.5 text-[9px]">
                    <div className="flex justify-between text-white/40"><span>Levels</span><span className="text-white/70 font-mono">{levels.length}</span></div>
                    <div className="flex justify-between text-white/40"><span>Total Nodes</span><span className="text-white/70 font-mono">{tasks.length}</span></div>
                    <div className="flex justify-between text-white/40"><span>Leaf Tasks</span><span className="text-white/70 font-mono">{tasks.filter(t => !tasks.some(d => d.depends_on.includes(t.id))).length}</span></div>
                    <div className="flex justify-between text-white/40"><span>Root Tasks</span><span className="text-white/70 font-mono">{tasks.filter(t => t.depends_on.length === 0).length}</span></div>
                    <div className="flex justify-between text-white/40"><span>Elapsed</span><span className="text-white/70 font-mono">{formatElapsed(elapsed)}</span></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}