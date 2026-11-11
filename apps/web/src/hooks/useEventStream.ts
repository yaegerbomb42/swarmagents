"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface SwarmEvent {
  id: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export function useEventStream() {
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "system" && data.action === "heartbeat") return;
        setEvents((prev) => {
          const next = [data, ...prev];
          return next.slice(0, 50);
        });
      } catch {
        // ignore malformed
      }
    };

    es.onerror = () => {
      setConnected(false);
      // Auto-reconnect happens automatically for EventSource
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, connected, clearEvents };
}
