import { describe, it, expect, beforeEach } from 'vitest';
import { useLabStore } from './useLabStore';
import { createDefaultBlueprint } from './agentBlueprint';
import { MARKETPLACE_SEED_AGENTS } from './marketplaceCatalog';

describe('useLabStore (simplified)', () => {
  beforeEach(() => {
    useLabStore.setState({
      activeBlueprint: createDefaultBlueprint(),
      marketplaceAgents: [...MARKETPLACE_SEED_AGENTS],
      marketplaceCategory: 'all',
      marketplaceSearch: '',
      marketplaceSort: 'popular',
      isPublishModalOpen: false,
    });
  });

  it('forks a marketplace agent into a private draft blueprint', () => {
    const store = useLabStore.getState();
    const targetAgent = MARKETPLACE_SEED_AGENTS[0];

    store.forkBlueprint(targetAgent);
    const active = useLabStore.getState().activeBlueprint;

    expect(active.name).toContain('(Fork)');
    expect(active.forkedFromId).toBe(targetAgent.id);
    expect(active.isPublic).toBe(false);
  });

  it('publishes the active blueprint into the marketplace catalog', () => {
    const store = useLabStore.getState();
    store.forkBlueprint(MARKETPLACE_SEED_AGENTS[0]);

    store.publishBlueprint(['rust', 'auditing']);
    const state = useLabStore.getState();

    expect(state.activeBlueprint.isPublic).toBe(true);
    expect(state.activeBlueprint.domainTags).toEqual(['rust', 'auditing']);
    expect(state.isPublishModalOpen).toBe(false);
    expect(state.marketplaceAgents[0].id).toBe(state.activeBlueprint.id);
    expect(state.marketplaceAgents[0].isPublic).toBe(true);
  });

  it('updates marketplace category, search, and sort state', () => {
    const store = useLabStore.getState();
    store.setMarketplaceCategory('rust');
    store.setMarketplaceSearch('tokio');
    store.setMarketplaceSort('recent');
    store.setPublishModalOpen(true);

    const state = useLabStore.getState();
    expect(state.marketplaceCategory).toBe('rust');
    expect(state.marketplaceSearch).toBe('tokio');
    expect(state.marketplaceSort).toBe('recent');
    expect(state.isPublishModalOpen).toBe(true);
  });
});
