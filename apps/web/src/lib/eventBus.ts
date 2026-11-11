// Event Bus — Server-Sent Events (SSE) for real-time updates
// Enables live dashboard updates without polling

const EVENT_BUS_KEY = '__swarm_event_bus__';

export interface SwarmEvent {
  id: string;
  type: 'orchestrator' | 'task' | 'agent' | 'team' | 'profile' | 'system';
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

class EventBus {
  private listeners = new Set<(event: SwarmEvent) => void>();
  private history: SwarmEvent[] = [];
  private maxHistory = 100;

  subscribe(listener: (event: SwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Omit<SwarmEvent, 'id' | 'timestamp'>) {
    const fullEvent: SwarmEvent = {
      ...event,
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.history.push(fullEvent);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this.listeners.forEach((l) => l(fullEvent));
  }

  getHistory(type?: SwarmEvent['type']): SwarmEvent[] {
    if (!type) return [...this.history];
    return this.history.filter((e) => e.type === type);
  }

  // Emit helpers
  orchestrator(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'orchestrator', action, payload });
  }

  task(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'task', action, payload });
  }

  agent(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'agent', action, payload });
  }

  team(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'team', action, payload });
  }

  profile(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'profile', action, payload });
  }

  system(action: string, payload: Record<string, unknown>) {
    this.emit({ type: 'system', action, payload });
  }
}

// Global singleton
function getGlobalBus(): EventBus {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as any;
    if (!g[EVENT_BUS_KEY]) {
      g[EVENT_BUS_KEY] = new EventBus();
    }
    return g[EVENT_BUS_KEY];
  }
  return new EventBus();
}

export const eventBus = getGlobalBus();
