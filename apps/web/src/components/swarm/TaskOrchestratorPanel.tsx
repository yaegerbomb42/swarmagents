"use client";

import { useState, useEffect } from 'react';
import { Play, Square, RotateCcw, Send, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';

interface SwarmTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  assigned_agent_id?: string;
  result?: string;
  error?: string;
  retry_count: number;
  created_at: number;
}

export default function TaskOrchestratorPanel() {
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState(5);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  const fetchTasks = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/orchestrator/tasks', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) setTasks(data.tasks || []);
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    } finally {
      setRefreshing(false);
    }
  };

  const submitTask = async () => {
    if (!taskTitle.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/orchestrator/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          title: taskTitle,
          description: taskDesc,
          priority: taskPriority,
          requirements: [],
        }),
      });
      setTaskTitle('');
      setTaskDesc('');
      setTaskPriority(5);
      await fetchTasks();
    } finally {
      setLoading(false);
    }
  };

  const cancelTask = async (taskId: string) => {
    await fetch('/api/orchestrator/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', taskId }),
    });
    await fetchTasks();
  };

  const retryTask = async (taskId: string) => {
    await fetch('/api/orchestrator/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', taskId }),
    });
    await fetchTasks();
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-emerald-400';
      case 'failed': return 'text-red-400';
      case 'running': return 'text-amber-400';
      case 'queued': return 'text-blue-400';
      case 'assigned': return 'text-purple-400';
      case 'paused': return 'text-orange-400';
      case 'cancelled': return 'text-gray-400';
      default: return 'text-white/40';
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={12} className="text-emerald-400" />;
      case 'failed': return <XCircle size={12} className="text-red-400" />;
      case 'running': return <Loader2 size={12} className="animate-spin text-amber-400" />;
      default: return <Clock size={12} className="text-white/30" />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-4">
        <h3 className="text-xs font-semibold text-white/60 mb-3">Create Task</h3>
        <div className="space-y-2">
          <input
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            placeholder="Task title..."
            className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:border-cyan-500/30"
          />
          <textarea
            value={taskDesc}
            onChange={(e) => setTaskDesc(e.target.value)}
            placeholder="Description..."
            rows={2}
            className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-white/20 resize-none focus:outline-none focus:border-cyan-500/30"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40">Priority:</span>
            <input
              type="range"
              min={1}
              max={10}
              value={taskPriority}
              onChange={(e) => setTaskPriority(Number(e.target.value))}
              className="w-24 accent-cyan-500"
            />
            <span className="text-xs text-cyan-400 font-mono w-4">{taskPriority}</span>
            <button
              onClick={submitTask}
              disabled={loading || !taskTitle.trim()}
              className="ml-auto flex items-center gap-1.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white text-[10px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-30 transition-opacity"
            >
              <Send size={10} />
              Submit
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-white/60">Tasks ({tasks.length})</h3>
          <button onClick={fetchTasks} className="text-white/20 hover:text-white/50 transition-colors">
            <RotateCcw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {tasks.length === 0 && (
            <div className="text-center text-xs text-white/20 py-8">No tasks yet</div>
          )}
          {tasks.map((task) => (
            <div key={task.id} className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 hover:bg-white/[0.03] transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {statusIcon(task.status)}
                    <span className={`text-xs font-medium ${statusColor(task.status)}`}>{task.status}</span>
                    <span className="text-[10px] text-white/30 font-mono">#{task.id.split('_').pop()}</span>
                  </div>
                  <div className="text-xs text-white/70 truncate">{task.title}</div>
                  {task.description && <div className="text-[10px] text-white/30 truncate">{task.description}</div>}
                  {task.assigned_agent_id && (
                    <div className="text-[10px] text-cyan-400/60 mt-1">Agent: {task.assigned_agent_id}</div>
                  )}
                  {task.result && (
                    <div className="text-[10px] text-emerald-400/60 mt-1 truncate">Result: {task.result}</div>
                  )}
                  {task.error && (
                    <div className="text-[10px] text-red-400/60 mt-1 truncate">Error: {task.error}</div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {task.status === 'failed' && (
                    <button onClick={() => retryTask(task.id)} className="text-white/20 hover:text-emerald-400 transition-colors">
                      <RotateCcw size={12} />
                    </button>
                  )}
                  {(task.status === 'queued' || task.status === 'assigned' || task.status === 'running') && (
                    <button onClick={() => cancelTask(task.id)} className="text-white/20 hover:text-red-400 transition-colors">
                      <Square size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
