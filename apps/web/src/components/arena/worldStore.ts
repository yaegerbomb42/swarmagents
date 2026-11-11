// Lightweight global event bus + state for the arena.
// Keeps brain decisions, agent actions, and UI HUD in sync without
// drilling props through every R3F component.

import { useSyncExternalStore } from 'react';
import type { AgentPerception, AgentAction, Interactable } from './AgentBrain';

interface ThoughtLogEntry {
  id: string;
  ts: number;
  agentId: string;
  agentLabel: string;
  perception: AgentPerception;
  action: AgentAction;
}

interface WorldState {
  agents: Record<string, AgentRuntime>;
  selectedAgentId: string | null;
  brainProviderId: string;            // 'reflex' | 'hamiltonian' | 'random'
  hamiltonianEndpoint: string;
  hamiltonianModel: string;
  hamiltonianApiKey: string;          // Bearer token for non-local providers
  hamiltonianPresetId: string;        // 'ollama-local' | 'openai' | 'groq' | 'cerebras' | 'anthropic' | 'custom'
  cameraMode: 'orbit' | 'pov' | 'over-shoulder' | 'cinematic';
  timeScale: number;                  // 0 = pause, 1 = real, 2 / 4 = fast forward
  thoughts: ThoughtLogEntry[];        // newest first
  brokenWalls: Set<string>;
  tvChannel: Record<string, number>;
}

export interface AgentRuntime {
  id: string;
  label: string;
  color: string;
  mood: AgentPerception['S_t']['mood'];
  energy: number;
  position: { x: number; y: number; z: number };
  holding: string | null;
  lastSpeech?: { text: string; ts: number };
  lastDecisionMs?: number;
  // Properties from engine API
  status?: string;
  active_tasks?: number;
  tasks_completed?: number;
  tasks_failed?: number;
  avg_response_time?: number;
  success_rate?: number;
}

const INITIAL: WorldState = {
  agents: {},
  selectedAgentId: null,
  brainProviderId: 'reflex',
  hamiltonianEndpoint: 'http://localhost:11434/api/generate',
  hamiltonianModel: 'deepseek-r1-0528-qwen3:8b',
  hamiltonianApiKey: '',
  hamiltonianPresetId: 'ollama-local',
  cameraMode: 'orbit',
  timeScale: 1,
  thoughts: [],
  brokenWalls: new Set(),
  tvChannel: { tv1: 0 },
};

let state: WorldState = INITIAL;
const listeners = new Set<() => void>();

function emit() { listeners.forEach(l => l()); }

export const world = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },

  registerAgent: (a: AgentRuntime) => {
    state = { ...state, agents: { ...state.agents, [a.id]: a } };
    if (!state.selectedAgentId) state.selectedAgentId = a.id;
    emit();
  },
  updateAgent: (id: string, patch: Partial<AgentRuntime>) => {
    const cur = state.agents[id]; if (!cur) return;
    state = { ...state, agents: { ...state.agents, [id]: { ...cur, ...patch } } };
    emit();
  },
  setSelected: (id: string) => { state = { ...state, selectedAgentId: id }; emit(); },

  setBrainProvider: (id: string) => { state = { ...state, brainProviderId: id }; emit(); },
  setHamiltonianEndpoint: (ep: string) => { state = { ...state, hamiltonianEndpoint: ep }; emit(); },
  setHamiltonianModel: (m: string) => { state = { ...state, hamiltonianModel: m }; emit(); },
  setHamiltonianApiKey: (k: string) => { state = { ...state, hamiltonianApiKey: k }; emit(); },
  setHamiltonianPreset: (presetId: string, endpoint: string, model: string) => {
    state = { ...state, hamiltonianPresetId: presetId, hamiltonianEndpoint: endpoint, hamiltonianModel: model };
    emit();
  },

  setCameraMode: (m: WorldState['cameraMode']) => { state = { ...state, cameraMode: m }; emit(); },
  setTimeScale: (s: number) => { state = { ...state, timeScale: s }; emit(); },

  recordThought: (entry: Omit<ThoughtLogEntry, 'id' | 'ts'>) => {
    const e: ThoughtLogEntry = { ...entry, id: `${entry.agentId}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, ts: Date.now() };
    state = { ...state, thoughts: [e, ...state.thoughts].slice(0, 200) };
    emit();
  },

  setSpeech: (id: string, text: string) => {
    const cur = state.agents[id]; if (!cur) return;
    state = { ...state, agents: { ...state.agents, [id]: { ...cur, lastSpeech: { text, ts: Date.now() } } } };
    emit();
  },

  breakWall: (wallId: string) => {
    if (state.brokenWalls.has(wallId)) return;
    const next = new Set(state.brokenWalls); next.add(wallId);
    state = { ...state, brokenWalls: next };
    emit();
  },

  cycleTvChannel: (tvId: string, channelCount: number) => {
    const cur = state.tvChannel[tvId] ?? 0;
    state = { ...state, tvChannel: { ...state.tvChannel, [tvId]: (cur + 1) % channelCount } };
    emit();
  },
};

export function useWorld<T>(selector: (s: WorldState) => T): T {
  return useSyncExternalStore(world.subscribe, () => selector(world.get()), () => selector(INITIAL));
}
