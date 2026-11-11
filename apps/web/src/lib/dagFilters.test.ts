import { describe, it, expect } from 'vitest';
import {
  DAG_STATUS_FILTERS,
  keyToFocusDelta,
  matchesFilter,
  nextFocusIndex,
  orderForKeyboard,
  resolveDagHighlight,
  type DagNodeLike,
} from './dagFilters';

const node = (over: Partial<DagNodeLike> & { id: string }): DagNodeLike => ({
  status: 'pending',
  ...over,
});

const NODES: DagNodeLike[] = [
  node({ id: 'root', status: 'executing', depth: 0, label: 'Build the thing' }),
  node({ id: 'a', status: 'completed', depth: 1, label: 'Scaffold repo' }),
  node({ id: 'b', status: 'failed', depth: 1, label: 'Wire the API' }),
  node({ id: 'c', status: 'pending', depth: 2, description: 'Polish API errors' }),
  node({ id: 'd', status: 'validating', depth: 2, label: 'Verify schema' }),
];

describe('matchesFilter', () => {
  it('keeps every node for the "all" filter', () => {
    for (const n of NODES) expect(matchesFilter(n, 'all')).toBe(true);
  });

  it.each([
    ['live', ['root', 'd']],
    ['done', ['a']],
    ['failed', ['b']],
    ['queued', ['c']],
  ] as const)('buckets %s correctly', (filter, expected) => {
    expect(NODES.filter((n) => matchesFilter(n, filter)).map((n) => n.id)).toEqual([
      ...expected,
    ]);
  });

  it('treats unknown statuses as queued', () => {
    expect(matchesFilter(node({ id: 'x', status: 'weird' }), 'queued')).toBe(true);
  });
});

describe('resolveDagHighlight', () => {
  it('highlights everything by default', () => {
    const { matchIds, count, total } = resolveDagHighlight(NODES);
    expect(count).toBe(5);
    expect(total).toBe(5);
    expect(matchIds.has('c')).toBe(true);
  });

  it('filters by status', () => {
    const { matchIds } = resolveDagHighlight(NODES, { filter: 'failed' });
    expect([...matchIds]).toEqual(['b']);
  });

  it('searches labels case-insensitively', () => {
    const { matchIds } = resolveDagHighlight(NODES, { query: 'scaffold' });
    expect([...matchIds]).toEqual(['a']);
  });

  it('searches descriptions when no label is present', () => {
    const { matchIds } = resolveDagHighlight(NODES, { query: 'polish' });
    expect([...matchIds]).toEqual(['c']);
  });

  it('matches on node id as a fallback', () => {
    const { matchIds } = resolveDagHighlight(NODES, { query: 'root' });
    expect([...matchIds]).toEqual(['root']);
  });

  it('intersects status filter and query', () => {
    const { matchIds } = resolveDagHighlight(NODES, { filter: 'live', query: 'api' });
    expect([...matchIds]).toEqual([]);
  });

  it('returns an empty set rather than throwing when nothing matches', () => {
    const { matchIds, count } = resolveDagHighlight(NODES, { query: 'zzzz' });
    expect(count).toBe(0);
    expect(matchIds.size).toBe(0);
  });

  it('ignores a whitespace-only query', () => {
    expect(resolveDagHighlight(NODES, { query: '   ' }).count).toBe(5);
  });
});

describe('orderForKeyboard', () => {
  it('orders breadth-first from the root', () => {
    const all = new Set(NODES.map((n) => n.id));
    expect(orderForKeyboard(NODES, all)).toEqual(['root', 'a', 'b', 'c', 'd']);
  });

  it('preserves source order within a depth level', () => {
    const all = new Set(NODES.map((n) => n.id));
    const reversed = [...NODES].reverse();
    expect(orderForKeyboard(reversed, all)).toEqual(['root', 'b', 'a', 'd', 'c']);
  });

  it('skips nodes outside the highlight set', () => {
    expect(orderForKeyboard(NODES, new Set(['c']))).toEqual(['c']);
  });
});

describe('nextFocusIndex', () => {
  it('starts at the top when moving forward from nothing', () => {
    expect(nextFocusIndex(5, -1, 1)).toBe(0);
  });

  it('starts at the bottom when moving backward from nothing', () => {
    expect(nextFocusIndex(5, -1, -1)).toBe(4);
  });

  it('wraps in both directions', () => {
    expect(nextFocusIndex(3, 2, 1)).toBe(0);
    expect(nextFocusIndex(3, 0, -1)).toBe(2);
  });

  it('returns -1 for an empty collection', () => {
    expect(nextFocusIndex(0, 0, 1)).toBe(-1);
  });
});

describe('keyToFocusDelta', () => {
  it.each([
    ['ArrowDown', 1],
    ['j', 1],
    ['ArrowUp', -1],
    ['k', -1],
  ])('maps %s to %i', (key, expected) => {
    expect(keyToFocusDelta(key)).toBe(expected);
  });

  it.each(['Enter', 'Escape', 'a', 'Tab', ' '])(
    'does not consume %s so typing is unaffected',
    (key) => {
      expect(keyToFocusDelta(key)).toBeNull();
    },
  );
});

describe('DAG_STATUS_FILTERS', () => {
  it('exposes a stable, de-duplicated filter list starting with all', () => {
    expect(DAG_STATUS_FILTERS[0].id).toBe('all');
    expect(new Set(DAG_STATUS_FILTERS.map((f) => f.id)).size).toBe(
      DAG_STATUS_FILTERS.length,
    );
  });
});