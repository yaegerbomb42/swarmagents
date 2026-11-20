import {
  type ScopeNode,
  type ScopeState,
  type Fact,
  type ReturnContract,
  type ChildScopeRequest,
  defaultBudgetCurve,
} from './types.js';
import { TypedMemory } from './typed-memory.js';

export interface ScopeTreeOptions {
  storageDir: string;
  repoRoot: string;
  baseBudget?: number;
  inheritedRules?: string[];
}

export class ScopeTree {
  readonly root: ScopeNode;
  readonly storageDir: string;
  readonly repoRoot: string;
  readonly baseBudget: number;
  readonly inheritedRules: string[];

  private nodes = new Map<string, ScopeNode>();
  private memories = new Map<string, TypedMemory>();

  constructor(rootGoal: string, acceptanceCriteria: string[], options: ScopeTreeOptions) {
    this.storageDir = options.storageDir;
    this.repoRoot = options.repoRoot;
    this.baseBudget = options.baseBudget ?? 32_000;
    this.inheritedRules = options.inheritedRules ?? [
      'Maintain documentation integrity and preserve comments.',
      'No lost green commits or unverified progress claims.',
      'Never commit code that fails verification gates.',
    ];

    const rootState: ScopeState = {
      goal: rootGoal,
      acceptanceCriteria,
      plan: [],
      doneItems: [],
      nextAction: 'Decompose goal into focused sub-problems',
      depth: 0,
    };

    this.root = {
      id: 'root',
      goal: rootGoal,
      budget: defaultBudgetCurve(0, this.baseBudget),
      depth: 0,
      plan: [],
      children: [],
      state: rootState,
    };

    this.nodes.set(this.root.id, this.root);
  }

  /**
   * Get or create typed memory instance for a specific scope.
   */
  getMemory(scopeId: string): TypedMemory {
    let mem = this.memories.get(scopeId);
    if (!mem) {
      mem = new TypedMemory({
        scopeId,
        storageDir: this.storageDir,
        repoRoot: this.repoRoot,
      });
      this.memories.set(scopeId, mem);
    }
    return mem;
  }

  /**
   * Initialize root memory state.
   */
  async initRoot(): Promise<void> {
    const mem = this.getMemory(this.root.id);
    await mem.writeState(this.root.state);
  }

  /**
   * Create a child scope narrowing down a sub-problem.
   * Context budget shrinks according to depth curve: 32k -> 12k -> 6k -> 4k.
   */
  async spawnChild(
    parentId: string,
    params: {
      subGoal: string;
      targetFiles: string[];
      targetSymbols?: string[];
      acceptanceCriteria?: string[];
    },
  ): Promise<{ node: ScopeNode; request: ChildScopeRequest }> {
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new Error(`Parent scope "${parentId}" not found in scope tree`);
    }

    const childDepth = parent.depth + 1;
    const childBudget = defaultBudgetCurve(childDepth, this.baseBudget);
    const childId = `${parentId}.c${parent.children.length + 1}`;

    // Filter relevant facts from parent
    const parentMem = this.getMemory(parentId);
    const parentFacts = await parentMem.getActiveFacts();
    const relevantFacts: Fact[] = parentFacts.filter((fact) =>
      params.targetFiles.some(
        (target) =>
          fact.file === target ||
          fact.file.endsWith(`/${target}`) ||
          target.endsWith(`/${fact.file}`),
      ),
    );

    const childCriteria = params.acceptanceCriteria ?? [params.subGoal];

    const childState: ScopeState = {
      goal: params.subGoal,
      acceptanceCriteria: childCriteria,
      plan: [],
      doneItems: [],
      nextAction: `Solve ${params.subGoal}`,
      depth: childDepth,
    };

    const childNode: ScopeNode = {
      id: childId,
      parentId,
      goal: params.subGoal,
      budget: childBudget,
      depth: childDepth,
      plan: [],
      children: [],
      state: childState,
    };

    // Save initial state into child typed memory
    const childMem = this.getMemory(childId);
    await childMem.writeState(childState);

    // Seed child memory with the relevant facts
    if (relevantFacts.length > 0) {
      await childMem.mergeFacts(relevantFacts);
    }

    parent.children.push(childNode);
    this.nodes.set(childId, childNode);

    const request: ChildScopeRequest = {
      id: childId,
      subGoal: params.subGoal,
      budget: childBudget,
      inheritedRules: [...this.inheritedRules],
      relevantFacts,
      targetFiles: params.targetFiles,
      ...(params.targetSymbols !== undefined ? { targetSymbols: params.targetSymbols } : {}),
      acceptanceCriteria: childCriteria,
      depth: childDepth,
    };

    return { node: childNode, request };
  }

  /**
   * Split a failing test into a dedicated sub-problem scope.
   */
  async splitByFailingTest(
    parentId: string,
    testFile: string,
    errorMessage: string,
    sourceFiles: string[],
  ): Promise<{ node: ScopeNode; request: ChildScopeRequest }> {
    const subGoal = `Fix test failure in ${testFile}: ${errorMessage.slice(0, 100)}`;
    const targetFiles = Array.from(new Set([testFile, ...sourceFiles]));
    return this.spawnChild(parentId, {
      subGoal,
      targetFiles,
      acceptanceCriteria: [`Tests in ${testFile} must pass`],
    });
  }

  /**
   * Split by specific file / module.
   */
  async splitByFile(
    parentId: string,
    file: string,
    goal: string,
    symbols?: string[],
  ): Promise<{ node: ScopeNode; request: ChildScopeRequest }> {
    return this.spawnChild(parentId, {
      subGoal: goal,
      targetFiles: [file],
      ...(symbols !== undefined ? { targetSymbols: symbols } : {}),
      acceptanceCriteria: [`Complete edits for ${file} satisfying: ${goal}`],
    });
  }

  /**
   * Record completion of a scope with compact ReturnContract.
   * Discards the child's working memory context and keeps only the compact result.
   */
  recordResult(scopeId: string, result: ReturnContract): ScopeNode {
    const node = this.nodes.get(scopeId);
    if (!node) throw new Error(`Scope "${scopeId}" not found`);

    node.result = result;
    return node;
  }

  /**
   * Get all nodes as flat list.
   */
  getAllNodes(): ScopeNode[] {
    return Array.from(this.nodes.values());
  }
}
