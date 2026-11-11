"use client";

import { useEffect } from "react";
import { useSwarmStore } from "@/stores/swarmStore";
import { agentsApi, tasksApi, orchestratorApi, capabilitiesApi, statsApi } from "@/services/api";
import { startEventStream, stopEventStream } from "@/services/websocket";

export function useSwarmData() {
  const store = useSwarmStore();

  useEffect(() => {
    // Start SSE connection
    startEventStream();

    // Initial data fetch
    const fetchAll = async () => {
      const [agentsRes, tasksRes, statsRes, orchRes, capsRes] = await Promise.all([
        agentsApi.list(),
        tasksApi.list(),
        statsApi.get(),
        orchestratorApi.getState(),
        capabilitiesApi.listProfiles(),
      ]);

      if (agentsRes.ok) store.setAgents(agentsRes.data.agents);
      if (tasksRes.ok) store.setTasks(tasksRes.data.tasks);
      if (orchRes.ok) store.setOrchestratorState(orchRes.data.state);
      if (capsRes.ok) store.setCapabilityProfiles(capsRes.data.profiles);
    };

    fetchAll();

    // Periodic refresh
    const interval = setInterval(fetchAll, 30000);

    return () => {
      clearInterval(interval);
      stopEventStream();
    };
  }, [store]);

  return store;
}
