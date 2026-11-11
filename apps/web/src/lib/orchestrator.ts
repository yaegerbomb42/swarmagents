// Emergent Orchestrator — Self-organizing coordination with lifecycle management
// Tasks 501-600: Emergent orchestration, task queues, scheduling, dispatching

import type {
  CapabilityRequirement,
  MatchResult,
  TeamFormationRequest,
  FormedTeam,
  CapabilityProfile,
} from "@/types/runtime";
import { eventBus } from "@/lib/eventBus";

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ─── Orchestrator Lifecycle ─────────────────────────────────────────

export type OrchestratorLifecycle =
  | "BOOTSTRAP"
  | "LEARNING"
  | "COORDINATING"
  | "ADAPTING"
  | "DEGRADED"
  | "RECOVERING";

export interface OrchestratorConfig {
  taskAssignmentStrategy: "round-robin" | "capability-based" | "performance-based" | "load-balanced";
  agentTimeoutSeconds: number;
  retryPolicy: "exponential-backoff" | "linear" | "fixed";
  loadBalanceWeight: number; // 0-1
  maxRetries: number;
  baseRetryDelayMs: number;
  learningEnabled: boolean;
}

export const defaultConfig: OrchestratorConfig = {
  taskAssignmentStrategy: "capability-based",
  agentTimeoutSeconds: 30,
  retryPolicy: "exponential-backoff",
  loadBalanceWeight: 0.5,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  learningEnabled: true,
};

// ─── Task Definitions ────────────────────────────────────────────────

export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  requirements: CapabilityRequirement[];
  priority: number; // 1-10, higher = more urgent
  status: "queued" | "assigned" | "running" | "completed" | "failed" | "cancelled";
  assignedAgentId?: string;
  assignedTeamId?: string;
  result?: string;
  error?: string;
  retryCount: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentHealth {
  agentId: string;
  agentName: string;
  status: "healthy" | "degraded" | "unhealthy" | "offline";
  lastHeartbeat: number;
  activeTasks: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  avgResponseTime: number;
  successRate: number; // 0-1
}

export interface OrchestratorState {
  lifecycle: OrchestratorLifecycle;
  confidence: number; // 0-1, confidence in learned heuristics
  config: OrchestratorConfig;
  tasks: SwarmTask[];
  agentHealth: AgentHealth[];
  queueDepth: number;
  throughput: number; // tasks/minute
  avgLatency: number; // ms
  errorRate: number; // 0-1
  lastStateChange: number;
  learnedHeuristics: Record<string, number>;
}

// ─── Emergent Orchestrator ──────────────────────────────────────────

export class EmergentOrchestrator {
  private state: OrchestratorState;
  private configHistory: Array<{ config: OrchestratorConfig; performance: number; timestamp: number }> = [];
  private taskQueue: SwarmTask[] = [];
  private runningTasks: Map<string, SwarmTask> = new Map();
  private agentLoads: Map<string, number> = new Map();
  private capabilityProfiles: CapabilityProfile[] = [];
  private formedTeams: FormedTeam[] = [];
  private listeners: Array<(state: OrchestratorState) => void> = [];

  constructor(initialConfig: Partial<OrchestratorConfig> = {}) {
    this.state = {
      lifecycle: "BOOTSTRAP",
      confidence: 0.0,
      config: { ...defaultConfig, ...initialConfig },
      tasks: [],
      agentHealth: [],
      queueDepth: 0,
      throughput: 0,
      avgLatency: 0,
      errorRate: 0,
      lastStateChange: now(),
      learnedHeuristics: {},
    };
  }

  subscribe(listener: (state: OrchestratorState) => void): () => void {
    this.listeners.push(listener);
    listener(this.getState());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit() {
    const state = this.getState();
    this.listeners.forEach((l) => l(state));
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      tasks: [...this.state.tasks],
      agentHealth: [...this.state.agentHealth],
      queueDepth: this.taskQueue.length,
    };
  }

  // ─── Lifecycle Management (Task 502) ─────────────────────────────

  transitionLifecycle(target: OrchestratorLifecycle) {
    const prev = this.state.lifecycle;
    if (prev === target) return;

    // Validation rules
    const validTransitions: Record<OrchestratorLifecycle, OrchestratorLifecycle[]> = {
      BOOTSTRAP: ["LEARNING", "COORDINATING"],
      LEARNING: ["COORDINATING", "BOOTSTRAP"],
      COORDINATING: ["ADAPTING", "DEGRADED", "LEARNING"],
      ADAPTING: ["COORDINATING", "DEGRADED"],
      DEGRADED: ["RECOVERING", "ADAPTING"],
      RECOVERING: ["COORDINATING", "DEGRADED", "BOOTSTRAP"],
    };

    if (!validTransitions[prev].includes(target)) {
      console.warn(`[Orchestrator] Invalid transition: ${prev} → ${target}`);
      return;
    }

    this.state.lifecycle = target;
    this.state.lastStateChange = now();

    // Lifecycle-specific behavior
    switch (target) {
      case "LEARNING":
        this.state.confidence = 0.3;
        break;
      case "COORDINATING":
        this.state.confidence = Math.min(1, this.state.confidence + 0.2);
        break;
      case "ADAPTING":
        this.experimentWithStrategies();
        break;
      case "DEGRADED":
        this.state.config.taskAssignmentStrategy = "load-balanced";
        this.state.config.agentTimeoutSeconds = Math.max(this.state.config.agentTimeoutSeconds * 2, 60);
        break;
      case "RECOVERING":
        this.state.config.taskAssignmentStrategy = "capability-based";
        break;
    }

    eventBus.orchestrator("lifecycle_change", {
      from: prev,
      to: target,
      confidence: this.state.confidence,
      timestamp: now(),
    });

    this.emit();
  }

  evaluateLifecycle() {
    const healthyAgents = this.state.agentHealth.filter((a) => a.status === "healthy").length;
    const totalAgents = this.state.agentHealth.length || 1;
    const healthRatio = healthyAgents / totalAgents;
    const errorRate = this.computeErrorRate();

    if (healthRatio < 0.7) {
      this.transitionLifecycle("DEGRADED");
    } else if (errorRate > 0.15) {
      this.transitionLifecycle("ADAPTING");
    } else if (this.state.lifecycle === "BOOTSTRAP" && this.state.tasks.length > 10) {
      this.transitionLifecycle("LEARNING");
    } else if (this.state.lifecycle === "LEARNING" && this.state.confidence > 0.6) {
      this.transitionLifecycle("COORDINATING");
    } else if (this.state.lifecycle === "DEGRADED" && healthRatio > 0.85) {
      this.transitionLifecycle("RECOVERING");
    } else if (this.state.lifecycle === "RECOVERING" && healthRatio > 0.95) {
      this.transitionLifecycle("COORDINATING");
    }
  }

  private computeErrorRate(): number {
    const recentTasks = this.state.tasks.filter((t) => t.createdAt > now() - 60000);
    if (!recentTasks.length) return 0;
    const failed = recentTasks.filter((t) => t.status === "failed").length;
    return failed / recentTasks.length;
  }

  // ─── Self-Tuning (Task 503) ────────────────────────────────────────

  private experimentWithStrategies() {
    if (!this.state.config.learningEnabled) return;

    // Try different strategies and measure performance
    const strategies: OrchestratorConfig["taskAssignmentStrategy"][] = [
      "round-robin",
      "capability-based",
      "performance-based",
      "load-balanced",
    ];

    // Pick a strategy that hasn't been tried recently
    const untried = strategies.filter(
      (s) => !this.configHistory.some((h) => h.config.taskAssignmentStrategy === s && h.timestamp > now() - 300000)
    );

    if (untried.length > 0) {
      const next = untried[Math.floor(Math.random() * untried.length)];
      this.state.config.taskAssignmentStrategy = next;
    }
  }

  recordConfigPerformance(performance: number) {
    this.configHistory.push({
      config: { ...this.state.config },
      performance,
      timestamp: now(),
    });

    // Keep last 50 entries
    if (this.configHistory.length > 50) {
      this.configHistory = this.configHistory.slice(-50);
    }

    // Auto-rollback if performance degraded significantly
    if (this.configHistory.length >= 3) {
      const recent = this.configHistory.slice(-3);
      const avgRecent = recent.reduce((s, h) => s + h.performance, 0) / recent.length;
      const best = Math.max(...this.configHistory.map((h) => h.performance));

      if (avgRecent < best * 0.7) {
        // Rollback to best config
        const bestEntry = this.configHistory.find((h) => h.performance === best);
        if (bestEntry) {
          this.state.config = { ...bestEntry.config };
          this.state.learnedHeuristics.rollback_count = (this.state.learnedHeuristics.rollback_count || 0) + 1;
        }
      }
    }
  }

  // ─── Task Management (Tasks 521-538) ───────────────────────────────

  submitTask(input: Omit<SwarmTask, "id" | "status" | "retryCount" | "createdAt">): SwarmTask {
    const task: SwarmTask = {
      ...input,
      id: uid(),
      status: "queued",
      retryCount: 0,
      createdAt: now(),
    };

    this.taskQueue.push(task);
    this.state.tasks = [task, ...this.state.tasks];
    this.state.queueDepth = this.taskQueue.length;

    // Sort by priority (higher first)
    this.taskQueue.sort((a, b) => b.priority - a.priority);

    eventBus.task("submitted", {
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      queueDepth: this.taskQueue.length,
    });

    this.emit();
    return task;
  }

  cancelTask(taskId: string): boolean {
    const idx = this.state.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;

    const task = this.state.tasks[idx];
    if (task.status === "running") {
      // Graceful: mark for cancellation
      this.runningTasks.delete(taskId);
    }

    task.status = "cancelled";
    this.taskQueue = this.taskQueue.filter((t) => t.id !== taskId);
    this.state.queueDepth = this.taskQueue.length;
    this.emit();
    return true;
  }

  retryTask(taskId: string): SwarmTask | null {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.retryCount >= this.state.config.maxRetries) return null;

    task.retryCount++;
    task.status = "queued";
    task.error = undefined;
    this.taskQueue.push(task);
    this.taskQueue.sort((a, b) => b.priority - a.priority);
    this.state.queueDepth = this.taskQueue.length;
    this.emit();
    return task;
  }

  // ─── Scheduling & Dispatching (Tasks 524-526) ──────────────────────

  scheduleAndDispatch(): SwarmTask | null {
    if (!this.taskQueue.length) return null;
    if (this.state.lifecycle === "DEGRADED" && this.runningTasks.size >= 3) {
      // Conservative scheduling in degraded mode
      return null;
    }

    const task = this.taskQueue.shift()!;
    this.state.queueDepth = this.taskQueue.length;

    // Find best agent
    const agent = this.selectAgentForTask(task);
    if (!agent) {
      // No agent available, requeue
      task.status = "queued";
      this.taskQueue.unshift(task);
      this.state.queueDepth = this.taskQueue.length;
      return null;
    }

    task.status = "running";
    task.assignedAgentId = agent.agentId;
    task.startedAt = now();
    this.runningTasks.set(task.id, task);
    this.agentLoads.set(agent.agentId, (this.agentLoads.get(agent.agentId) || 0) + 1);

    this.emit();
    return task;
  }

  private selectAgentForTask(task: SwarmTask): AgentHealth | null {
    const available = this.state.agentHealth.filter(
      (a) => a.status === "healthy" && (this.agentLoads.get(a.agentId) || 0) < 5
    );

    if (!available.length) return null;

    switch (this.state.config.taskAssignmentStrategy) {
      case "round-robin":
        return available[Math.floor(Math.random() * available.length)];

      case "load-balanced":
        return available.reduce((best, a) =>
          (this.agentLoads.get(a.agentId) || 0) < (this.agentLoads.get(best.agentId) || 0) ? a : best
        );

      case "performance-based":
        return available.reduce((best, a) => (a.successRate > best.successRate ? a : best));

      case "capability-based":
      default: {
        // Match requirements to agent capabilities
        const profiles = this.capabilityProfiles.filter((p) =>
          available.some((a) => a.agentId === p.agentId)
        );

        if (!profiles.length || !task.requirements.length) {
          return available[0];
        }

        let bestAgent = available[0];
        let bestScore = -1;

        for (const agent of available) {
          const profile = profiles.find((p) => p.agentId === agent.agentId);
          if (!profile) continue;

          let score = 0;
          for (const req of task.requirements) {
            const cap = profile.capabilitySet.find((c) => c.name === req.capability);
            if (cap && cap.proficiency >= req.minimumProficiency) {
              score += cap.proficiency * req.weight;
            }
          }

          // Penalize load
          score *= 1 - (this.agentLoads.get(agent.agentId) || 0) * 0.1;

          if (score > bestScore) {
            bestScore = score;
            bestAgent = agent;
          }
        }

        return bestAgent;
      }
    }
  }

  // ─── Task Completion ──────────────────────────────────────────────

  completeTask(taskId: string, result: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.status = "completed";
    task.result = result;
    task.completedAt = now();
    this.runningTasks.delete(taskId);

    if (task.assignedAgentId) {
      this.agentLoads.set(task.assignedAgentId, Math.max(0, (this.agentLoads.get(task.assignedAgentId) || 0) - 1));
    }

    eventBus.task("completed", {
      taskId: task.id,
      title: task.title,
      assignedAgentId: task.assignedAgentId,
      result: result.slice(0, 200),
    });

    this.updateThroughput();
    this.evaluateLifecycle();
    this.emit();
  }

  failTask(taskId: string, error: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.status = "failed";
    task.error = error;
    task.completedAt = now();
    this.runningTasks.delete(taskId);

    if (task.assignedAgentId) {
      this.agentLoads.set(task.assignedAgentId, Math.max(0, (this.agentLoads.get(task.assignedAgentId) || 0) - 1));
    }

    eventBus.task("failed", {
      taskId: task.id,
      title: task.title,
      error: error.slice(0, 200),
      retryCount: task.retryCount,
      willRetry: task.retryCount < this.state.config.maxRetries,
    });

    // Auto-retry if configured
    if (task.retryCount < this.state.config.maxRetries) {
      const delay = this.computeRetryDelay(task.retryCount);
      setTimeout(() => this.retryTask(taskId), delay);
    }

    this.updateThroughput();
    this.evaluateLifecycle();
    this.emit();
  }

  private computeRetryDelay(retryCount: number): number {
    const base = this.state.config.baseRetryDelayMs;
    switch (this.state.config.retryPolicy) {
      case "exponential-backoff":
        return base * Math.pow(2, retryCount);
      case "linear":
        return base * (retryCount + 1);
      case "fixed":
      default:
        return base;
    }
  }

  private updateThroughput() {
    const recent = this.state.tasks.filter((t) => t.completedAt && t.completedAt > now() - 60000);
    this.state.throughput = recent.length;

    const latencies = recent
      .filter((t) => t.startedAt && t.completedAt)
      .map((t) => t.completedAt! - t.startedAt!);
    this.state.avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  }

  // ─── Agent Health (Task 508) ─────────────────────────────────────

  updateAgentHealth(health: AgentHealth) {
    const idx = this.state.agentHealth.findIndex((a) => a.agentId === health.agentId);
    if (idx >= 0) {
      this.state.agentHealth[idx] = health;
    } else {
      this.state.agentHealth.push(health);
    }
    this.evaluateLifecycle();
    this.emit();
  }

  registerCapabilityProfiles(profiles: CapabilityProfile[]) {
    this.capabilityProfiles = profiles;
  }

  registerTeams(teams: FormedTeam[]) {
    this.formedTeams = teams;
  }

  // ─── Persistence (Task 504) ────────────────────────────────────────

  snapshot(): string {
    return JSON.stringify({
      state: this.state,
      configHistory: this.configHistory,
      queue: this.taskQueue.map((t) => t.id),
      loads: Object.fromEntries(this.agentLoads),
    });
  }

  restore(snapshotJson: string) {
    try {
      const data = JSON.parse(snapshotJson);
      if (data.state) {
        this.state = { ...this.state, ...data.state };
      }
      if (data.configHistory) {
        this.configHistory = data.configHistory;
      }
      this.emit();
    } catch (e) {
      console.error("[Orchestrator] Failed to restore snapshot:", e);
    }
  }
}

// Singleton instance
export const orchestrator = new EmergentOrchestrator();
