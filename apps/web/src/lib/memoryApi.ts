export type EpisodicEntry = {
  lesson_id?: string;
  lesson_text?: string;
  context?: string;
  lesson_type?: string;
  related_file?: string;
  severity?: string;
  occurrences?: number;
};

export type EpisodicMemoryResponse = {
  entries: EpisodicEntry[];
  count: number;
  active_goal?: Record<string, unknown>;
};

export async function fetchEpisodicMemory(query = ''): Promise<EpisodicMemoryResponse> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  const res = await fetch(`/api/memory/episodic${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`episodic memory fetch failed: ${res.status}`);
  }
  return (await res.json()) as EpisodicMemoryResponse;
}

export async function fetchActiveGoal(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/memory/active-goal', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`active goal fetch failed: ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchWorkingSet(): Promise<unknown> {
  const res = await fetch('/api/memory/working-set', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`working set fetch failed: ${res.status}`);
  }
  return res.json();
}
