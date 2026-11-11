'use client';

import { useState, useEffect } from 'react';
import { Brain, Play, Square, RotateCcw, Zap, Clock, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

interface Task {
  id: string;
  priority: string;
  category: string;
  title: string;
  description: string;
  targetFiles: string[];
  status: string;
  createdAt: number;
  subAgents: { role: string; output: string }[];
}

interface AutonomousState {
  isRunning: boolean;
  currentTask: Task | null;
  taskQueue: Task[];
  completedTasks: Task[];
  lastRunAt: number | null;
  totalIterations: number;
  totalTokensUsed: number;
  totalCost: number;
  currentCycle: number;
  errors: string[];
}

export default function AutonomousPanel() {
  const [state, setState] = useState<AutonomousState | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState('medium');
  const [newTaskCategory, setNewTaskCategory] = useState('feature');

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/autonomous');
      const data = await res.json();
      if (data.ok) setState(data.state);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const sendAction = async (action: string, extra = {}) => {
    setLoading(true);
    setActionError('');
    try {
      const res = await fetch('/api/autonomous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (data.ok) {
        setState(data.state);
      } else {
        setActionError(data.error || 'Action failed');
      }
    } catch (e: any) {
      setActionError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const addTask = async () => {
    if (!newTaskTitle.trim() || !newTaskDesc.trim()) return;
    await sendAction('add_task', {
      title: newTaskTitle,
      description: newTaskDesc,
      priority: newTaskPriority,
      category: newTaskCategory,
    });
    setNewTaskTitle('');
    setNewTaskDesc('');
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  return (
    <div className="space-y-4">
      {/* Status Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className={`${state?.isRunning ? 'text-cyan-400' : 'text-white/30'}`} size={20} />
          <div>
            <h3 className="text-sm font-semibold text-white/80">Autonomous Agent</h3>
            <p className="text-[11px] text-white/40">
              {state?.isRunning ? `Running · Cycle ${state.currentCycle}` : 'Stopped'} · {state?.taskQueue.length ?? 0} queued
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state?.isRunning ? (
            <button
              onClick={() => sendAction('stop')}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all text-[11px] font-medium"
            >
              <Square size={12} /> Stop
            </button>
          ) : (
            <button
              onClick={() => sendAction('start')}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all text-[11px] font-medium"
            >
              <Play size={12} /> Start
            </button>
          )}
          <button
            onClick={() => sendAction('cycle')}
            disabled={loading || !state?.isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] text-white/60 border border-white/[0.06] hover:bg-white/[0.08] transition-all text-[11px] font-medium"
          >
            <RotateCcw size={12} /> Run Now
          </button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg bg-red-500/5 border border-red-500/10 p-2 text-[11px] text-red-400">
          {actionError}
        </div>
      )}

      {/* Stats */}
      {state && (
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.015] p-2.5">
            <div className="text-[10px] text-white/30 mb-1">Iterations</div>
            <div className="text-lg font-bold text-white/80">{state.totalIterations}</div>
          </div>
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.015] p-2.5">
            <div className="text-[10px] text-white/30 mb-1">Completed</div>
            <div className="text-lg font-bold text-white/80">{state.completedTasks.length}</div>
          </div>
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.015] p-2.5">
            <div className="text-[10px] text-white/30 mb-1">Queued</div>
            <div className="text-lg font-bold text-white/80">{state.taskQueue.length}</div>
          </div>
          <div className="rounded-lg border border-white/[0.04] bg-white/[0.015] p-2.5">
            <div className="text-[10px] text-white/30 mb-1">Last Run</div>
            <div className="text-sm font-medium text-white/80">{formatTime(state.lastRunAt)}</div>
          </div>
        </div>
      )}

      {/* Current Task */}
      {state?.currentTask && (
        <div className="rounded-lg border border-cyan-500/10 bg-cyan-500/[0.02] p-3">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 size={14} className="text-cyan-400 animate-spin" />
            <span className="text-[11px] font-medium text-cyan-400">Current Task</span>
          </div>
          <p className="text-sm text-white/80 mb-1">{state.currentTask.title}</p>
          <p className="text-[11px] text-white/40">{state.currentTask.description.slice(0, 120)}...</p>
          <div className="flex gap-1 mt-2">
            {state.currentTask.subAgents.map((sa, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/40">
                {sa.role}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Task Queue */}
      {state && state.taskQueue.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-white/50 mb-2 uppercase tracking-wider">Task Queue</h4>
          <div className="space-y-1.5">
            {state.taskQueue.slice(0, 5).map(task => (
              <div key={task.id} className="flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] p-2">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  task.priority === 'critical' ? 'bg-red-400' :
                  task.priority === 'high' ? 'bg-orange-400' :
                  task.priority === 'medium' ? 'bg-yellow-400' : 'bg-green-400'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-white/70 truncate">{task.title}</p>
                  <p className="text-[10px] text-white/30">{task.category} · {task.targetFiles.length} files</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Task */}
      <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] p-3 space-y-2">
        <h4 className="text-[11px] font-medium text-white/50 uppercase tracking-wider">Add Task</h4>
        <input
          type="text"
          value={newTaskTitle}
          onChange={e => setNewTaskTitle(e.target.value)}
          placeholder="Task title..."
          className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-[12px] text-white/80"
        />
        <textarea
          value={newTaskDesc}
          onChange={e => setNewTaskDesc(e.target.value)}
          placeholder="What should the autonomous agent do?"
          rows={2}
          className="w-full px-2 py-1.5 rounded bg-black/30 border border-white/10 text-[12px] text-white/80 resize-y"
        />
        <div className="flex gap-2">
          <select
            value={newTaskPriority}
            onChange={e => setNewTaskPriority(e.target.value)}
            className="px-2 py-1 rounded bg-black/30 border border-white/10 text-[11px] text-white/60"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value={newTaskCategory}
            onChange={e => setNewTaskCategory(e.target.value)}
            className="px-2 py-1 rounded bg-black/30 border border-white/10 text-[11px] text-white/60"
          >
            <option value="ui">UI</option>
            <option value="backend">Backend</option>
            <option value="api">API</option>
            <option value="agent">Agent</option>
            <option value="memory">Memory</option>
            <option value="performance">Performance</option>
            <option value="bugfix">Bugfix</option>
            <option value="feature">Feature</option>
          </select>
          <button
            onClick={addTask}
            disabled={loading || !newTaskTitle.trim() || !newTaskDesc.trim()}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all text-[11px] font-medium disabled:opacity-30"
          >
            <Zap size={12} /> Queue Task
          </button>
        </div>
      </div>

      {/* Errors */}
      {state && state.errors.length > 0 && (
        <div className="rounded-lg border border-red-500/10 bg-red-500/[0.02] p-2">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertCircle size={10} className="text-red-400" />
            <span className="text-[10px] text-red-400 font-medium">Recent Errors</span>
          </div>
          <div className="space-y-0.5">
            {state.errors.slice(-3).map((err, i) => (
              <p key={i} className="text-[10px] text-white/30 truncate">{err}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
