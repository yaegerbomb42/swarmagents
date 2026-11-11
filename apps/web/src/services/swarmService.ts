import { get, post } from './api';

function engineBase(): string {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_ENGINE_URL || '/api/engine';
  }
  return process.env.ENGINE_URL || 'http://localhost:8400';
}

export const swarmService = {
  getAgents: async () => {
    const base = engineBase();
    const res = await fetch(`${base}/agents`, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      return data.agents || [];
    }
    const apiRes = await get<{ agents: unknown[] }>('/api/agents');
    if (apiRes.ok) return apiRes.data.agents || [];
    return [];
  },

  getStatus: async () => {
    const base = engineBase();
    const res = await fetch(`${base}/health`, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      return { running: data.status === 'healthy' || data.active_agents > 0, ...data };
    }
    return { running: false };
  },

  submitTask: async (task: {
    title: string;
    description?: string;
    priority?: number;
    requirements?: string[];
  }) => {
    const base = engineBase();
    const res = await fetch(`${base}/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: task.title,
        description: task.description || '',
        priority: task.priority || 5,
        requirements: task.requirements || [],
        source: 'swarm_service',
      }),
    }).catch(() => null);

    if (res?.ok) {
      const data = await res.json();
      return { id: data.task?.id || '', status: data.task?.status || 'queued' };
    }

    try {
      const apiRes = await post<{ task: { id?: string; status?: string } }>(
        '/api/orchestrator/tasks',
        {
          action: 'submit',
          title: task.title,
          description: task.description || '',
          priority: task.priority || 5,
          requirements: task.requirements || [],
        },
      );
      if (apiRes.ok) {
        return {
          id: apiRes.data.task?.id || '',
          status: apiRes.data.task?.status || 'pending',
        };
      }
    } catch {
      /* fall through */
    }

    return { id: '', status: 'pending' };
  },
};
