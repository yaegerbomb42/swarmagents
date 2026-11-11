/**
 * SWARMAGENTS - Agent Metrics Collector
 * 
 * Centralized system for tracking agent performance, decisions, and health.
 * Provides data for the Observability Dashboard.
 * 
 * Based on AgentOps and best practices for system transparency.
 */

import { EventEmitter } from 'events';

export class AgentMetricsCollector extends EventEmitter {
    metrics: {
        totalTokens: number;
        activeAgents: number;
        taskSuccessCount: number;
        taskFailureCount: number;
        toolUsage: Record<string, number>;
        agentDecisions: Array<{
            ts: number;
            agentId: string;
            decision: string;
            reason: string;
        }>;
    };
    agentStats: Map<string, any>;

    constructor() {
        super();
        this.metrics = {
            totalTokens: 0,
            activeAgents: 0,
            taskSuccessCount: 0,
            taskFailureCount: 0,
            toolUsage: {},  // Map of tool_name -> count
            agentDecisions: [], // Log of recent critical decisions
        };
        this.agentStats = new Map(); // agentId -> stats object
    }

    /**
     * Register a new agent to track
     */
    registerAgent(agent) {
        if (this.agentStats.has(agent.id)) return;

        this.agentStats.set(agent.id, {
            name: agent.name,
            role: agent.role,
            startTime: Date.now(),
            stepsTaken: 0,
            toolsUsed: [],
            lastAction: null,
            status: 'idle',
            errors: 0
        });

        // Hook into agent events if possible, but orchestration usually handles event piping
        this.metrics.activeAgents++;
        this.emit('metrics_update', this.getSystemSnapshot());
    }

    /**
     * Record an agent action/tool call
     */
    recordAction(agentId, toolName, reason = '') {
        // Update global tool usage
        this.metrics.toolUsage[toolName] = (this.metrics.toolUsage[toolName] || 0) + 1;

        // Update agent specific stats
        const stats = this.agentStats.get(agentId);
        if (stats) {
            stats.stepsTaken++;
            stats.toolsUsed.push({ name: toolName, ts: Date.now() });
            stats.lastAction = { type: 'tool', name: toolName, reason };

            // Keep tool history short
            if (stats.toolsUsed.length > 50) stats.toolsUsed.shift();
        }

        // Log decision path
        this.metrics.agentDecisions.push({
            ts: Date.now(),
            agentId,
            decision: `Chose tool ${toolName}`,
            reason
        });

        // Keep decision log manageable
        if (this.metrics.agentDecisions.length > 100) this.metrics.agentDecisions.shift();

        this.emit('metrics_update', this.getSystemSnapshot());
    }

    /**
     * Record token usage
     */
    recordTokens(count) {
        this.metrics.totalTokens += count;
    }

    /**
     * Update agent status
     */
    updateAgentStatus(agentId, status) {
        const stats = this.agentStats.get(agentId);
        if (stats) {
            stats.status = status;
        }
    }

    /**
     * Record task completion
     */
    recordTaskCompletion(agentId, success) {
        if (success) this.metrics.taskSuccessCount++;
        else this.metrics.taskFailureCount++;

        const stats = this.agentStats.get(agentId);
        if (stats) {
            stats.endTime = Date.now();
            stats.success = success;
        }

        // We don't decrement activeAgents here immediately as it might get another task
        // Orchestrator handles agent lifecycle
    }

    /**
     * Get a full snapshot of the system state for the UI
     */
    getSystemSnapshot() {
        return {
            global: {
                ...this.metrics,
                uptime: process.uptime(),
            },
            agents: Array.from(this.agentStats.entries()).map(([id, stats]) => ({
                id,
                ...stats,
                duration: ((stats.endTime || Date.now()) - stats.startTime) / 1000
            }))
        };
    }
}

// Singleton
let instance = null;

export function getMetricsCollector() {
    if (!instance) instance = new AgentMetricsCollector();
    return instance;
}
