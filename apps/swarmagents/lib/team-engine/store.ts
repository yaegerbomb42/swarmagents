import type { Store, TeamRunState } from './types';

export class MemoryStore implements Store {
  private readonly states = new Map<string, TeamRunState>();

  async load(runId: string): Promise<TeamRunState | null> {
    const existing = this.states.get(runId);
    return existing ? structuredClone(existing) : null;
  }

  async save(state: TeamRunState): Promise<void> {
    this.states.set(state.runId, structuredClone(state));
  }

  has(runId: string): boolean {
    return this.states.has(runId);
  }

  clear(): void {
    this.states.clear();
  }
}
