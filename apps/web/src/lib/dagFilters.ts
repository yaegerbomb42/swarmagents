/**
 * Pure selection / focus logic for the decomposition DAG.
 *
 * Kept out of the React Flow component so the behaviour (status filtering,
 * text search, keyboard traversal order) can be unit-tested without a DOM
 * layout engine, and so the canvas stays a thin rendering layer.
 */

export type DagNodeLike = {
  id: string;
  status: string;
  description?: string;
  label?: string;
  depth?: number;
  parent_id?: string | null;
  type?: string;
};

export type DagStatusFilter = 'all' | 'live' | 'failed' | 'done' | 'queued';

export const DAG_STATUS_FILTERS: ReadonlyArray<{ id: DagStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'failed', label: 'Failed' },
  { id: 'done', label: 'Done' },
  { id: 'queued', label: 'Queued' },
];

const LIVE = new Set(['executing', 'assigned', 'decomposing', 'running', 'validating']);
const DONE = new Set(['completed', 'done']);
const FAILED = new Set(['failed', 'cancelled']);
const QUEUED = new Set(['ready', 'pending', 'paused']);

function statusBucket(status: string): DagStatusFilter {
  if (LIVE.has(status)) return 'live';
  if (DONE.has(status)) return 'done';
  if (FAILED.has(status)) return 'failed';
  if (QUEUED.has(status)) return 'queued';
  return 'queued';
}

/** True when `node` should stay highlighted under `filter`. */
export function matchesFilter(node: DagNodeLike, filter: DagStatusFilter): boolean {
  if (filter === 'all') return true;
  return statusBucket(node.status) === filter;
}

/** Human label for a node, preferring the short label over the full description. */
export function nodeText(node: DagNodeLike): string {
  return (node.label || node.description || node.id).toString();
}

export type DagHighlightOptions = {
  filter?: DagStatusFilter;
  query?: string;
};

export type DagHighlight = {
  matchIds: Set<string>;
  count: number;
  /** Total nodes considered, before filtering. */
  total: number;
};

/**
 * Resolves which node ids match the active filter + search query.
 * An empty result is meaningful: the caller renders everything dimmed rather
 * than blanking the canvas, preserving DAG topology while focusing a subset.
 */
export function resolveDagHighlight(
  nodes: readonly DagNodeLike[],
  { filter = 'all', query = '' }: DagHighlightOptions = {},
): DagHighlight {
  const needle = query.trim().toLowerCase();
  const matchIds = new Set<string>();

  for (const node of nodes) {
    if (!matchesFilter(node, filter)) continue;
    if (needle) {
      const haystack = `${nodeText(node)} ${node.id}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    matchIds.add(node.id);
  }

  return { matchIds, count: matchIds.size, total: nodes.length };
}

/**
 * Deterministic traversal order for keyboard focus: top of the DAG first,
 * then stable by original list order (which mirrors server emission order).
 */
export function orderForKeyboard(
  nodes: readonly DagNodeLike[],
  matchIds: ReadonlySet<string>,
): string[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => matchIds.has(node.id))
    .sort((a, b) => {
      const depthDelta = (a.node.depth ?? 0) - (b.node.depth ?? 0);
      return depthDelta !== 0 ? depthDelta : a.index - b.index;
    })
    .map(({ node }) => node.id);
}

/** Clamped, wrap-around cursor movement for arrow-key traversal. */
export function nextFocusIndex(length: number, current: number, delta: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}

/**
 * Maps a keydown to a focus movement delta.
 * Arrow keys mirror the vim-style j/k bindings so both muscle memories work.
 * Returns null for keys the DAG should not consume (so typing stays untouched).
 */
export function keyToFocusDelta(key: string): number | null {
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return 1;
    case 'ArrowUp':
    case 'k':
      return -1;
    default:
      return null;
  }
}
