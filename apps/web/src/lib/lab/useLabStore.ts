/**
 * SwarmAgents Lab — Simplified Zustand State Store
 *
 * Retains the blueprint workspace and marketplace catalog interactions.
 * Agent creation and library browsing now talk directly to /api/lab/roles.
 */

import { create } from 'zustand';
import { AgentBlueprint, AgentCategory, createDefaultBlueprint } from './agentBlueprint';
import { MARKETPLACE_SEED_AGENTS } from './marketplaceCatalog';

export type SortOption = 'popular' | 'rating' | 'runs' | 'recent';

export interface LabState {
  activeBlueprint: AgentBlueprint;

  // Marketplace state
  marketplaceAgents: AgentBlueprint[];
  marketplaceCategory: 'all' | AgentCategory;
  marketplaceSearch: string;
  marketplaceSort: SortOption;
  isPublishModalOpen: boolean;

  // Actions
  forkBlueprint: (blueprint: AgentBlueprint) => void;
  publishBlueprint: (customTags?: string[], releaseNotes?: string) => void;
  setMarketplaceCategory: (cat: 'all' | AgentCategory) => void;
  setMarketplaceSearch: (q: string) => void;
  setMarketplaceSort: (sort: SortOption) => void;
  setPublishModalOpen: (open: boolean) => void;
}

const LOCAL_STORAGE_CUSTOM_AGENTS = 'swarmagents_lab_custom_agents_v1';

function getInitialMarketplaceAgents(): AgentBlueprint[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return MARKETPLACE_SEED_AGENTS;
  }
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_CUSTOM_AGENTS);
    if (!raw) return MARKETPLACE_SEED_AGENTS;
    const custom = JSON.parse(raw);
    return [...MARKETPLACE_SEED_AGENTS, ...custom];
  } catch {
    return MARKETPLACE_SEED_AGENTS;
  }
}

export const useLabStore = create<LabState>((set, get) => ({
  activeBlueprint: createDefaultBlueprint(),

  marketplaceAgents: getInitialMarketplaceAgents(),
  marketplaceCategory: 'all',
  marketplaceSearch: '',
  marketplaceSort: 'popular',
  isPublishModalOpen: false,

  forkBlueprint: (blueprint) => {
    const forked: AgentBlueprint = {
      ...JSON.parse(JSON.stringify(blueprint)),
      id: `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${blueprint.name} (Fork)`,
      forkedFromId: blueprint.id,
      forkCount: 0,
      runCount: 0,
      rating: 5.0,
      ratingCount: 1,
      author: {
        id: 'usr-local',
        name: 'You (Private Studio)',
        verified: true,
      },
      isPublic: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    set({ activeBlueprint: forked });
  },

  publishBlueprint: (customTags) => {
    const { activeBlueprint, marketplaceAgents } = get();
    const published: AgentBlueprint = {
      ...JSON.parse(JSON.stringify(activeBlueprint)),
      id: activeBlueprint.id.startsWith('market-') ? activeBlueprint.id : `market-${activeBlueprint.id}`,
      isPublic: true,
      version: activeBlueprint.version || '1.0.0',
      domainTags: customTags && customTags.length > 0 ? customTags : activeBlueprint.domainTags,
      updatedAt: new Date().toISOString(),
    };

    const filtered = marketplaceAgents.filter((a) => a.id !== published.id);
    const nextCatalog = [published, ...filtered];

    if (typeof localStorage !== 'undefined') {
      const userCustomOnly = nextCatalog.filter(
        (a) => !MARKETPLACE_SEED_AGENTS.some((s) => s.id === a.id)
      );
      try {
        localStorage.setItem(LOCAL_STORAGE_CUSTOM_AGENTS, JSON.stringify(userCustomOnly));
      } catch {
        // storage unavailable (private mode/quota) — non-fatal
      }
    }

    set({
      marketplaceAgents: nextCatalog,
      activeBlueprint: published,
      isPublishModalOpen: false,
    });
  },

  setMarketplaceCategory: (cat) => set({ marketplaceCategory: cat }),
  setMarketplaceSearch: (q) => set({ marketplaceSearch: q }),
  setMarketplaceSort: (sort) => set({ marketplaceSort: sort }),
  setPublishModalOpen: (open) => set({ isPublishModalOpen: open }),
}));
