/**
 * Step 7.1 — Oracle-Guided Tree Search: the bounded candidate tree.
 *
 * Roadmap mapping: the brief's Step 7.1 is the simplified form of roadmap
 * Step 7.1 (Search Node Schema & DAG Transposition Table, `src/agent/search/`).
 * This file implements the node schema in the brief's shape — a plain tree with
 * bounded expansion — and deliberately does NOT implement the roadmap's
 * transposition table (converging branches are not merged into a DAG here), the
 * `Q`/`N`/`prior` fields, or patch-hash indexing. Those are follow-ups, not
 * part of this PR.
 *
 * Bounds (enforced by {@link SearchTree.addChild}, which returns `null` when a
 * bound would be exceeded — the search loop treats that as "cannot expand"):
 *   - max depth 4 (`MAX_DEPTH`)
 *   - max branching factor 3 (`MAX_BRANCHING`)
 *   - max total nodes 12 (`MAX_NODES`)
 *
 * The tree is a plain in-memory structure with no I/O. Node ids are assigned
 * deterministically from a counter (`n0` is the root, then `n1`, `n2`, …) so
 * tests can predict them.
 */

/** Max depth of the tree (root is depth 0). */
export const MAX_DEPTH = 4;
/** Max children any one node may have. */
export const MAX_BRANCHING = 3;
/** Max nodes in the whole tree, root included. */
export const MAX_NODES = 12;

/**
 * Minimal agent-state snapshot tracked per node. The search only needs to know
 * what stage/step the agent reached when the node's patch was produced; the
 * full agent state lives with the agent loop and is deliberately not copied
 * here.
 */
export interface NodeState {
  /** Human-readable label for this state (e.g. the stage that produced it). */
  label: string;
  /** Number of agent steps taken to reach this state. */
  steps: number;
}

/** One node in the candidate exploration tree. */
export interface SearchNode {
  /** Deterministic id (`n0`, `n1`, …). */
  id: string;
  /** Id of the parent node, or `null` for the root. */
  parentId: string | null;
  /** Depth in the tree (root is 0). */
  depth: number;
  /** Agent-state snapshot at this node. */
  state: NodeState;
  /** Candidate patch as a unified-diff string; empty for the root. */
  patchDiff: string;
  /** Sum of the expansion costs along the path from the root to this node. */
  cumulativeCost: number;
  /** Times this node has been visited / expanded. */
  visits: number;
  /** Value score of the candidate at this node (0–1, see `value.ts`). */
  valueScore: number;
}

/** A root-to-leaf path through the tree. */
export interface CandidatePath {
  /** Nodes from the root down to the leaf, in order. */
  nodes: readonly SearchNode[];
  /** Sum of `valueScore` over the nodes on the path. */
  totalValue: number;
  /** `cumulativeCost` of the leaf (the cost of the whole path). */
  totalCost: number;
}

/** In-memory bounded search tree. */
export class SearchTree {
  private readonly nodes = new Map<string, SearchNode>();
  private readonly children = new Map<string, string[]>();
  private nextId = 0;
  private readonly rootId: string;

  constructor(rootState: NodeState) {
    const root: SearchNode = {
      id: this.freshId(),
      parentId: null,
      depth: 0,
      state: rootState,
      patchDiff: '',
      cumulativeCost: 0,
      visits: 0,
      valueScore: 0,
    };
    this.nodes.set(root.id, root);
    this.children.set(root.id, []);
    this.rootId = root.id;
  }

  /** The root node. */
  get root(): SearchNode {
    const root = this.nodes.get(this.rootId);
    if (root === undefined) {
      throw new Error('unreachable: search tree has no root');
    }
    return root;
  }

  /** Number of nodes currently in the tree (root included). */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Look a node up by id; `undefined` when it does not exist. */
  getNode(id: string): SearchNode | undefined {
    return this.nodes.get(id);
  }

  /** Children of a node, in insertion order; empty array when unknown. */
  childrenOf(parentId: string): readonly SearchNode[] {
    const ids = this.children.get(parentId) ?? [];
    const out: SearchNode[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node !== undefined) {
        out.push(node);
      }
    }
    return out;
  }

  /** Nodes with no children (the frontier leaves). */
  leafNodes(): readonly SearchNode[] {
    const leaves: SearchNode[] = [];
    for (const node of this.nodes.values()) {
      if ((this.children.get(node.id) ?? []).length === 0) {
        leaves.push(node);
      }
    }
    return leaves;
  }

  /**
   * Whether `parentId` can accept another child without breaking a bound.
   * A parent at max depth, a parent already at max branching, or a full tree
   * cannot expand.
   */
  canExpand(parentId: string): boolean {
    const parent = this.nodes.get(parentId);
    if (parent === undefined) {
      return false;
    }
    if (parent.depth >= MAX_DEPTH) {
      return false;
    }
    if ((this.children.get(parentId) ?? []).length >= MAX_BRANCHING) {
      return false;
    }
    if (this.nodes.size >= MAX_NODES) {
      return false;
    }
    return true;
  }

  /**
   * Add a child to `parentId` carrying `patchDiff` at expansion cost `cost`.
   * Returns the new node, or `null` when the parent is unknown or any bound
   * (depth / branching / total nodes) would be exceeded. The caller treats
   * `null` as "cannot expand" and stops that branch.
   */
  addChild(parentId: string, patchDiff: string, cost: number): SearchNode | null {
    if (!this.canExpand(parentId)) {
      return null;
    }
    const parent = this.nodes.get(parentId);
    if (parent === undefined) {
      return null;
    }
    const child: SearchNode = {
      id: this.freshId(),
      parentId,
      depth: parent.depth + 1,
      state: { label: parent.state.label, steps: parent.state.steps + 1 },
      patchDiff,
      cumulativeCost: parent.cumulativeCost + cost,
      visits: 0,
      valueScore: 0,
    };
    this.nodes.set(child.id, child);
    this.children.set(child.id, []);
    const siblings = this.children.get(parentId) ?? [];
    siblings.push(child.id);
    this.children.set(parentId, siblings);
    return child;
  }

  /** Record one visit to a node (e.g. when it is selected for expansion). */
  visit(id: string): void {
    const node = this.nodes.get(id);
    if (node !== undefined) {
      node.visits += 1;
    }
  }

  /** Set the value score of a node (see `value.ts`). */
  setScore(id: string, valueScore: number): void {
    const node = this.nodes.get(id);
    if (node !== undefined) {
      node.valueScore = valueScore;
    }
  }

  /**
   * The highest-value root-to-leaf path: the leaf whose path has the greatest
   * summed `valueScore`, ties broken by lowest `totalCost`, then by the
   * shortest path. Returns `null` only when the tree is empty (never for a
   * tree built through this class — it always has a root).
   */
  bestPath(): CandidatePath | null {
    const leaves = this.leafNodes();
    if (leaves.length === 0) {
      return null;
    }
    let best: CandidatePath | null = null;
    for (const leaf of leaves) {
      const path = this.pathTo(leaf.id);
      if (path === null) {
        continue;
      }
      if (
        best === null ||
        path.totalValue > best.totalValue ||
        (path.totalValue === best.totalValue && path.totalCost < best.totalCost) ||
        (path.totalValue === best.totalValue &&
          path.totalCost === best.totalCost &&
          path.nodes.length < best.nodes.length)
      ) {
        best = path;
      }
    }
    return best;
  }

  /** Root-to-node path for `id`; `null` when the node does not exist. */
  pathTo(id: string): CandidatePath | null {
    const leaf = this.nodes.get(id);
    if (leaf === undefined) {
      return null;
    }
    const nodes: SearchNode[] = [];
    let current: SearchNode | undefined = leaf;
    while (current !== undefined) {
      nodes.unshift(current);
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    let totalValue = 0;
    for (const node of nodes) {
      totalValue += node.valueScore;
    }
    return { nodes, totalValue, totalCost: leaf.cumulativeCost };
  }

  private freshId(): string {
    const id = `n${String(this.nextId)}`;
    this.nextId += 1;
    return id;
  }
}
