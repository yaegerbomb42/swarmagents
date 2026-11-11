// WebSocket / SSE Event Service
// Connects to /api/events and feeds into Zustand store

import { useSwarmStore } from "@/stores/swarmStore";

let eventSource: EventSource | null = null;
let reconnectTimer: any = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

export interface ServerEvent {
  id: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

function getStore() {
  return useSwarmStore.getState();
}

function connect() {
  if (eventSource) {
    eventSource.close();
  }

  if (typeof window === "undefined") return;

  eventSource = new EventSource("/api/events");

  eventSource.onopen = () => {
    reconnectAttempts = 0;
    console.log("[WebSocket] Connected to event stream");
  };

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as ServerEvent;
      if (data.type === "system" && data.action === "heartbeat") return;

      const store = getStore();
      store.addEvent(data);

      // Also update domain-specific state based on event type
      if (data.type === "task" && data.action === "submitted") {
        // Task was submitted — could refresh orchestrator state
      }
      if (data.type === "orchestrator" && data.action === "lifecycle_change") {
        // Lifecycle changed
      }
    } catch (err) {
      console.error("[WebSocket] Failed to parse event:", err);
    }
  };

  eventSource.onerror = () => {
    console.warn("[WebSocket] Connection error, will retry...");
    eventSource?.close();
    eventSource = null;

    // Exponential backoff
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connect, delay);
  };
}

export function startEventStream() {
  connect();
}

export function stopEventStream() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

export function isConnected(): boolean {
  return eventSource !== null && eventSource.readyState === EventSource.OPEN;
}
