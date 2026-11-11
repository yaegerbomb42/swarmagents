'use client';

import React, { useState, useEffect } from 'react';
import { Users, Bot, Play, Pause, Square, Plus, MoreVertical } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'idle' | 'active' | 'paused' | 'error';
  task: string;
  progress: number;
}

export default function AgentOrchestrationPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const response = await fetch('/api/agents/action');
        if (response.ok) {
          const data = await response.json();
          setAgents(data.agents || []);
        }
      } catch (error) {
        console.error('Failed to fetch agents:', error);
      }
    };

    fetchAgents();
    const interval = setInterval(fetchAgents, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleAgentAction = async (agentId: string, action: string) => {
    try {
      const response = await fetch('/api/agents/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, action }),
      });
      if (response.ok) {
        // Refresh agents after action
        const agentsResponse = await fetch('/api/agents/action');
        if (agentsResponse.ok) {
          const data = await agentsResponse.json();
          setAgents(data.agents || []);
        }
      }
    } catch (error) {
      console.error('Failed to execute agent action:', error);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-500';
      case 'paused': return 'bg-yellow-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-gray-400';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'active': return 'Active';
      case 'paused': return 'Paused';
      case 'error': return 'Error';
      default: return 'Idle';
    }
  };

  return (
    <div className="border-b border-gray-100 p-4">
      <h3 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Users size={14} className="text-blue-500" />
        Agent Orchestration
      </h3>

      <div className="space-y-2">
        {agents.map((agent) => (
          <div key={agent.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Bot size={14} className="text-blue-500" />
                <div className="font-medium text-gray-900 text-sm">{agent.name}</div>
                <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor(agent.status)}`} />
                <div className="text-[10px] uppercase tracking-wider text-gray-500">
                  {getStatusText(agent.status)}
                </div>
              </div>
              <button className="text-gray-400 hover:text-gray-600">
                <MoreVertical size={14} />
              </button>
            </div>

            {agent.task && (
              <div className="text-xs text-gray-600 mb-2 truncate">{agent.task}</div>
            )}

            {agent.status === 'active' && (
              <div className="w-full bg-gray-200 rounded-full h-1.5 mb-2">
                <div 
                  className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${agent.progress}%` }}
                />
              </div>
            )}

            <div className="flex items-center gap-1">
              {agent.status === 'idle' && (
                <button
                  onClick={() => handleAgentAction(agent.id, 'start')}
                  className="flex-1 rounded-lg bg-blue-50 px-2 py-1 text-blue-600 text-xs font-medium hover:bg-blue-100 transition-colors flex items-center justify-center gap-1"
                >
                  <Play size={10} />
                  Start
                </button>
              )}
              {agent.status === 'active' && (
                <>
                  <button
                    onClick={() => handleAgentAction(agent.id, 'pause')}
                    className="flex-1 rounded-lg bg-yellow-50 px-2 py-1 text-yellow-600 text-xs font-medium hover:bg-yellow-100 transition-colors flex items-center justify-center gap-1"
                  >
                    <Pause size={10} />
                    Pause
                  </button>
                  <button
                    onClick={() => handleAgentAction(agent.id, 'stop')}
                    className="flex-1 rounded-lg bg-red-50 px-2 py-1 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors flex items-center justify-center gap-1"
                  >
                    <Square size={10} />
                    Stop
                  </button>
                </>
              )}
              {agent.status === 'paused' && (
                <>
                  <button
                    onClick={() => handleAgentAction(agent.id, 'start')}
                    className="flex-1 rounded-lg bg-blue-50 px-2 py-1 text-blue-600 text-xs font-medium hover:bg-blue-100 transition-colors flex items-center justify-center gap-1"
                  >
                    <Play size={10} />
                    Resume
                  </button>
                  <button
                    onClick={() => handleAgentAction(agent.id, 'stop')}
                    className="flex-1 rounded-lg bg-red-50 px-2 py-1 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors flex items-center justify-center gap-1"
                  >
                    <Square size={10} />
                    Stop
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        <button className="w-full rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-gray-500 text-xs font-medium hover:bg-gray-100 transition-colors flex items-center justify-center gap-1">
          <Plus size={12} />
          Add Agent
        </button>
      </div>
    </div>
  );
}
