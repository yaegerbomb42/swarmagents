// SwarmStore — Global Zustand state with typed slices
// Tasks 1001-1100: React monorepo, Zustand, API client, WebSocket

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

// ─── Agent Types ───────────────────────────────────────────────────

export interface SwarmAgent {
  id: string;
  name: string;
  owner_name: string;
  lora_dna: Record<string, number>;
  tasks_completed: number;
  avg_score: number;
  fitness?: number;
  generation: number;
  in_collective: boolean;
}

// ─── Task Types ─────────────────────────────────────────────────────

export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  assignedAgentId?: string;
  result?: string;
  error?: string;
  retryCount: number;
  createdAt: number;
}

// ─── Orchestrator Types ────────────────────────────────────────────

export interface OrchestratorState {
  lifecycle: string;
  confidence: number;
  queueDepth: number;
  throughput: number;
  avgLatency: number;
  errorRate: number;
  tasks: SwarmTask[];
}

// ─── Capability Types ──────────────────────────────────────────────

export interface CapabilityProfile {
  id: string;
  agentId: string;
  agentName: string;
  capabilitySet: Array<{
    name: string;
    proficiency: number;
    experienceHours: number;
    taskCount: number;
    verified: boolean;
  }>;
  proficiencyLevel: number;
  experienceHours: number;
  taskCount: number;
  performanceMetrics: {
    quality: number;
    speed: number;
    reliability: number;
    collaboration: number;
  };
  lastUpdated: number;
}

export interface FormedTeam {
  id: string;
  members: Array<{
    agentId: string;
    agentName: string;
    totalScore: number;
    confidence: number;
  }>;
  coverage: number;
  diversityScore: number;
  predictedPerformance: number;
  formationStrategy: string;
  formedAt: number;
}

// ─── Event Types ────────────────────────────────────────────────────

export interface SwarmEvent {
  id: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ─── Store State ────────────────────────────────────────────────────

interface SwarmStore {
  // Agent slice
  agents: SwarmAgent[];
  selectedAgentId: string | null;
  agentMetrics: Record<string, { fitness: number; tasksCompleted: number }>;
  setAgents: (agents: SwarmAgent[]) => void;
  addAgent: (agent: SwarmAgent) => void;
  selectAgent: (id: string | null) => void;

  // Task slice
  tasks: SwarmTask[];
  taskQueues: { queued: SwarmTask[]; running: SwarmTask[]; completed: SwarmTask[] };
  setTasks: (tasks: SwarmTask[]) => void;
  addTask: (task: SwarmTask) => void;
  updateTask: (id: string, updates: Partial<SwarmTask>) => void;

  // Orchestrator slice
  orchestratorState: OrchestratorState | null;
  setOrchestratorState: (state: OrchestratorState) => void;

  // Capability slice
  capabilityProfiles: CapabilityProfile[];
  formedTeams: FormedTeam[];
  setCapabilityProfiles: (profiles: CapabilityProfile[]) => void;
  setFormedTeams: (teams: FormedTeam[]) => void;
  addProfile: (profile: CapabilityProfile) => void;
  addTeam: (team: FormedTeam) => void;

  // Event slice
  events: SwarmEvent[];
  addEvent: (event: SwarmEvent) => void;
  clearEvents: () => void;
}

// ─── Decomposition Tree Types ──────────────────────────────────────

export type DecompTool = "shell" | "browser" | "edit" | "test" | "search";
export type DecompModelTier = "grunt" | "specialist" | "architect";

export interface DecompNode {
  id: string;
  type: "area" | "task";
  label: string;
  description: string;
  priority: string;
  effort_minutes?: number;
  needs_deeper?: boolean;
  depends_on: string[];
  agent_class: string;
  /** Preferred model tier for routing */
  model_tier?: DecompModelTier;
  /** Tools this leaf may use */
  tools?: DecompTool[];
  /** Done-when checklist */
  acceptance_criteria?: string[];
  /** Expected artifact path or URL pattern */
  deliverable_path?: string;
  status: "pending" | "running" | "completed" | "failed";
  assignedAgent?: string;
  result?: string;
  completedAt?: number;
  runCount: number;
  purpose?: string;
  children: DecompNode[];
  parentId?: string;
  depth: number;
  collapsed?: boolean;
  /** Live execution telemetry (optional) */
  tokens_used?: number;
  tool_calls?: number;
  retries?: number;
  quality_score?: number;
}

export interface DecompTreeSummary {
  leafCount: number;
  areaCount: number;
  estimatedMinutes: number;
  criticalPathMinutes: number;
  parallelWidth: number;
  byAgentClass: Record<string, number>;
  byTool: Record<string, number>;
  costEstimateUsd: number;
  needsDeeper: number;
  withAcceptance: number;
  withDeps: number;
}

export interface DecompFit {
  status: "under" | "fit" | "over" | "unknown";
  budgetMinutes: number;
  estimatedMinutes: number;
  ratio: number;
  leafCount: number;
  targetLeaves: number;
  label: string;
  message: string;
}

export interface DecompSession {
  id: string;
  project: string;
  timeRequirement: string;
  budget_minutes?: number;
  target_leaves?: number;
  nodes: DecompNode[];
  project_title: string;
  total_effort: string;
  status: "active" | "completed" | "failed";
  createdAt: number;
  fit?: DecompFit | null;
  summary?: DecompTreeSummary | null;
  auto_deepen?: { enabled: boolean; deepenCalls?: number; rounds?: number };
}

// ─── Store State ────────────────────────────────────────────────────

interface SwarmStore {
  // Agent slice
  agents: SwarmAgent[];
  selectedAgentId: string | null;
  agentMetrics: Record<string, { fitness: number; tasksCompleted: number }>;
  setAgents: (agents: SwarmAgent[]) => void;
  addAgent: (agent: SwarmAgent) => void;
  selectAgent: (id: string | null) => void;

  // Task slice
  tasks: SwarmTask[];
  taskQueues: { queued: SwarmTask[]; running: SwarmTask[]; completed: SwarmTask[] };
  setTasks: (tasks: SwarmTask[]) => void;
  addTask: (task: SwarmTask) => void;
  updateTask: (id: string, updates: Partial<SwarmTask>) => void;

  // Orchestrator slice
  orchestratorState: OrchestratorState | null;
  setOrchestratorState: (state: OrchestratorState) => void;

  // Capability slice
  capabilityProfiles: CapabilityProfile[];
  formedTeams: FormedTeam[];
  setCapabilityProfiles: (profiles: CapabilityProfile[]) => void;
  setFormedTeams: (teams: FormedTeam[]) => void;
  addProfile: (profile: CapabilityProfile) => void;
  addTeam: (team: FormedTeam) => void;

  // Event slice
  events: SwarmEvent[];
  addEvent: (event: SwarmEvent) => void;
  clearEvents: () => void;

  // Decomposition Tree slice
  decompSession: DecompSession | null;
  decompLoading: boolean;
  decompError: string | null;
  setDecompSession: (session: DecompSession | null) => void;
  setDecompLoading: (loading: boolean) => void;
  setDecompError: (error: string | null) => void;
  updateDecompNode: (nodeId: string, updates: Partial<DecompNode>) => void;
  addDecompChildren: (parentId: string, children: DecompNode[]) => void;
  setDecompNodeStatus: (nodeId: string, status: DecompNode["status"]) => void;
  toggleNodeCollapse: (nodeId: string) => void;

  // UI slice
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  toastNotifications: Array<{ id: string; message: string; type: "info" | "success" | "error"; timestamp: number }>;
  addToast: (message: string, type?: "info" | "success" | "error") => void;
  removeToast: (id: string) => void;
  activePanel: string | null;
  setActivePanel: (panel: string | null) => void;
}

export const useSwarmStore = create<SwarmStore>()(
  devtools(
    persist(
      (set, get) => ({
        // ─── Agent Slice ────────────────────────────────────────────
        agents: [],
        selectedAgentId: null,
        agentMetrics: {},
        setAgents: (agents) => set({ agents }),
        addAgent: (agent) => set((state) => ({ agents: [agent, ...state.agents] })),
        selectAgent: (id) => set({ selectedAgentId: id }),

        // ─── Task Slice ─────────────────────────────────────────────
        tasks: [],
        taskQueues: { queued: [], running: [], completed: [] },
        setTasks: (tasks) =>
          set({
            tasks,
            taskQueues: {
              queued: tasks.filter((t) => t.status === "queued"),
              running: tasks.filter((t) => t.status === "running"),
              completed: tasks.filter((t) => t.status === "completed"),
            },
          }),
        addTask: (task) => set((state) => {
          const tasks = [task, ...state.tasks];
          return {
            tasks,
            taskQueues: {
              queued: tasks.filter((t) => t.status === "queued"),
              running: tasks.filter((t) => t.status === "running"),
              completed: tasks.filter((t) => t.status === "completed"),
            },
          };
        }),
        updateTask: (id, updates) =>
          set((state) => {
            const tasks = state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t));
            return {
              tasks,
              taskQueues: {
                queued: tasks.filter((t) => t.status === "queued"),
                running: tasks.filter((t) => t.status === "running"),
                completed: tasks.filter((t) => t.status === "completed"),
              },
            };
          }),

        // ─── Orchestrator Slice ─────────────────────────────────────
        orchestratorState: null,
        setOrchestratorState: (orchestratorState) => set({ orchestratorState }),

        // ─── Capability Slice ───────────────────────────────────────
        capabilityProfiles: [],
        formedTeams: [],
        setCapabilityProfiles: (capabilityProfiles) => set({ capabilityProfiles }),
        setFormedTeams: (formedTeams) => set({ formedTeams }),
        addProfile: (profile) =>
          set((state) => ({ capabilityProfiles: [profile, ...state.capabilityProfiles] })),
        addTeam: (team) => set((state) => ({ formedTeams: [team, ...state.formedTeams] })),

        // ─── Event Slice ────────────────────────────────────────────
        events: [],
        addEvent: (event) =>
          set((state) => ({ events: [event, ...state.events].slice(0, 50) })),
        clearEvents: () => set({ events: [] }),

        // ─── Decomposition Tree Slice ───────────────────────────────
        decompSession: null,
        decompLoading: false,
        decompError: null,
        setDecompSession: (decompSession) => set({ decompSession, decompError: null }),
        setDecompLoading: (decompLoading) => set({ decompLoading }),
        setDecompError: (decompError) => set({ decompError, decompLoading: false }),
        updateDecompNode: (nodeId, updates) =>
          set((state) => {
            if (!state.decompSession) return state;
            const patch = (nodes: DecompNode[]): DecompNode[] =>
              nodes.map((n) => {
                if (n.id === nodeId) return { ...n, ...updates };
                if (n.children) return { ...n, children: patch(n.children) };
                return n;
              });
            return { decompSession: { ...state.decompSession, nodes: patch(state.decompSession.nodes) } };
          }),
        addDecompChildren: (parentId, children) =>
          set((state) => {
            if (!state.decompSession) return state;
            const addChildren = (nodes: DecompNode[]): DecompNode[] =>
              nodes.map((n) => {
                if (n.id === parentId) {
                  const existing = n.children || [];
                  // Merge: avoid duplicates by id
                  const merged = [...existing];
                  for (const c of children) {
                    if (!merged.find((m) => m.id === c.id)) merged.push(c);
                  }
                  return { ...n, children: merged, needs_deeper: false };
                }
                if (n.children) return { ...n, children: addChildren(n.children) };
                return n;
              });
            return { decompSession: { ...state.decompSession, nodes: addChildren(state.decompSession.nodes) } };
          }),
        setDecompNodeStatus: (nodeId, status) =>
          set((state) => {
            if (!state.decompSession) return state;
            const patch = (nodes: DecompNode[]): DecompNode[] =>
              nodes.map((n) => {
                if (n.id === nodeId) return { ...n, status };
                if (n.children) return { ...n, children: patch(n.children) };
                return n;
              });
            return { decompSession: { ...state.decompSession, nodes: patch(state.decompSession.nodes) } };
          }),
        toggleNodeCollapse: (nodeId) =>
          set((state) => {
            if (!state.decompSession) return state;
            const toggle = (nodes: DecompNode[]): DecompNode[] =>
              nodes.map((n) => {
                if (n.id === nodeId) return { ...n, collapsed: !n.collapsed };
                if (n.children) return { ...n, children: toggle(n.children) };
                return n;
              });
            return { decompSession: { ...state.decompSession, nodes: toggle(state.decompSession.nodes) } };
          }),

        // ─── UI Slice ───────────────────────────────────────────────
        sidebarCollapsed: false,
        toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
        toastNotifications: [],
        addToast: (message, type = "info") =>
          set((state) => ({
            toastNotifications: [
              { id: `toast-${Date.now()}`, message, type, timestamp: Date.now() },
              ...state.toastNotifications,
            ].slice(0, 5),
          })),
        removeToast: (id) =>
          set((state) => ({
            toastNotifications: state.toastNotifications.filter((t) => t.id !== id),
          })),
        activePanel: null,
        setActivePanel: (activePanel) => set({ activePanel }),
      }),
      {
        name: "swarm-store",
        partialize: (state) => ({
          sidebarCollapsed: state.sidebarCollapsed,
          selectedAgentId: state.selectedAgentId,
        }),
      }
    ),
    { name: "SwarmStore" }
  )
);
