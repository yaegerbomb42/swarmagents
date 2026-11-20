import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../../core/atomic.js';
import { estimateTokens } from '../../core/tokens.js';
import {
  type Fact,
  type FailedAttempt,
  type ScopeState,
  type DoneItem,
  type TestEvidence,
  scopeStateSchema,
} from './types.js';

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return (await readJson(path)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function computeFileSha256(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function computeStringSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface TypedMemoryOptions {
  scopeId: string;
  storageDir: string;
  repoRoot: string;
}

export class TypedMemory {
  readonly scopeId: string;
  readonly storageDir: string;
  readonly repoRoot: string;

  private stateFilePath: string;
  private factsFilePath: string;
  private failedAttemptsPath: string;

  constructor(options: TypedMemoryOptions) {
    this.scopeId = options.scopeId;
    this.storageDir = options.storageDir;
    this.repoRoot = options.repoRoot;
    this.stateFilePath = join(this.storageDir, `scope-${this.scopeId}-state.json`);
    this.factsFilePath = join(this.storageDir, `scope-${this.scopeId}-facts.json`);
    this.failedAttemptsPath = join(this.storageDir, `scope-${this.scopeId}-failures.json`);
  }

  /**
   * Read current scope state.
   */
  async readState(): Promise<ScopeState> {
    const raw = await readJsonOr<unknown>(this.stateFilePath, null);
    if (!raw) {
      return {
        goal: '',
        acceptanceCriteria: [],
        plan: [],
        doneItems: [],
        nextAction: '',
        depth: 0,
      };
    }
    const parsed = scopeStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return {
      goal: '',
      acceptanceCriteria: [],
      plan: [],
      doneItems: [],
      nextAction: '',
      depth: 0,
    };
  }

  /**
   * Atomically save scope state.
   */
  async writeState(state: ScopeState): Promise<void> {
    await writeJsonAtomic(this.stateFilePath, state);
  }

  /**
   * Update next action in state.
   */
  async setNextAction(action: string): Promise<void> {
    const state = await this.readState();
    state.nextAction = action;
    await this.writeState(state);
  }

  /**
   * Record a completed item with verified evidence.
   */
  async addDoneItem(description: string, evidence: TestEvidence): Promise<DoneItem> {
    const state = await this.readState();
    const item: DoneItem = {
      id: `done-${Date.now()}-${state.doneItems.length + 1}`,
      description,
      evidence,
    };
    state.doneItems.push(item);
    await this.writeState(state);
    return item;
  }

  /**
   * Read stored facts.
   */
  async readAllFacts(): Promise<Fact[]> {
    return readJsonOr<Fact[]>(this.factsFilePath, []);
  }

  /**
   * Get active, unexpired facts.
   * Facts are bound to a file SHA-256 hash. If the file on disk was modified or deleted,
   * the fact is expired automatically.
   */
  async getActiveFacts(): Promise<Fact[]> {
    const facts = await this.readAllFacts();
    if (!facts.length) return [];

    const active: Fact[] = [];
    const hashCache = new Map<string, string | null>();

    for (const fact of facts) {
      const fullPath = join(this.repoRoot, fact.file);
      const cached = hashCache.get(fullPath);
      const currentHash = cached !== undefined ? cached : await computeFileSha256(fullPath);
      if (cached === undefined) {
        hashCache.set(fullPath, currentHash);
      }

      // If file hash matches what was recorded, the fact is valid and unexpired
      if (currentHash && currentHash === fact.fileHash) {
        active.push(fact);
      }
    }

    // If some facts expired, prune them from disk storage asynchronously
    if (active.length !== facts.length) {
      await writeJsonAtomic(this.factsFilePath, active);
    }

    return active;
  }

  /**
   * Record a new fact bound to the current file hash on disk.
   */
  async recordFact(file: string, statement: string, symbol?: string): Promise<Fact | null> {
    const fullPath = join(this.repoRoot, file);
    const hash = await computeFileSha256(fullPath);
    if (!hash) return null;

    const facts = await this.readAllFacts();
    const newFact: Fact = {
      id: `fact-${Date.now()}-${facts.length + 1}`,
      file,
      fileHash: hash,
      statement,
      ...(symbol !== undefined ? { symbol } : {}),
      timestamp: Date.now(),
    };

    // Deduplicate identical statement for same file
    const filtered = facts.filter(
      (f) => !(f.file === file && f.statement === statement && f.symbol === symbol),
    );
    filtered.push(newFact);
    await writeJsonAtomic(this.factsFilePath, filtered);
    return newFact;
  }

  /**
   * Record multiple facts (e.g. returned from a child scope).
   */
  async mergeFacts(newFacts: Fact[]): Promise<void> {
    if (!newFacts.length) return;
    const existing = await this.readAllFacts();
    const byKey = new Map<string, Fact>();
    for (const f of existing) {
      byKey.set(`${f.file}:${f.statement}:${f.symbol ?? ''}`, f);
    }
    for (const f of newFacts) {
      byKey.set(`${f.file}:${f.statement}:${f.symbol ?? ''}`, f);
    }
    await writeJsonAtomic(this.factsFilePath, Array.from(byKey.values()));
  }

  /**
   * Read failed attempts.
   */
  async readFailedAttempts(): Promise<FailedAttempt[]> {
    return readJsonOr<FailedAttempt[]>(this.failedAttemptsPath, []);
  }

  /**
   * Record a failed attempt.
   */
  async recordFailedAttempt(
    target: string,
    approach: string,
    error: string,
  ): Promise<FailedAttempt> {
    const attempts = await this.readFailedAttempts();
    const attempt: FailedAttempt = {
      id: `fail-${Date.now()}-${attempts.length + 1}`,
      target,
      approach,
      error,
      timestamp: Date.now(),
    };
    attempts.push(attempt);
    await writeJsonAtomic(this.failedAttemptsPath, attempts);
    return attempt;
  }

  /**
   * Build fresh context prompt for this call.
   * NO transcript is sent. Only typed memory state, unexpired facts,
   * rules, anti-patterns, and focused file contents.
   */
  async buildFreshContext(options: {
    inheritedRules: string[];
    subGoal?: string;
    targetFiles?: { path: string; content: string; symbols?: string[] }[];
    tokenBudget: number;
  }): Promise<{ prompt: string; estimatedTokens: number; activeFactsCount: number }> {
    const state = await this.readState();
    const facts = await this.getActiveFacts();
    const failures = await this.readFailedAttempts();

    const sections: string[] = [];

    // 1. Inherited Rules (Verbatim)
    if (options.inheritedRules.length > 0) {
      sections.push(
        '# Core Invariants & Rules\n' +
          options.inheritedRules.map((rule, idx) => `${idx + 1}. ${rule}`).join('\n'),
      );
    }

    // 2. Goal & Scope
    sections.push(
      '# Goal & Scope\n' +
        `**Root Goal:** ${state.goal}\n` +
        (options.subGoal ? `**Sub-Problem Goal:** ${options.subGoal}\n` : '') +
        `**Scope Depth:** ${state.depth}\n` +
        `**Context Budget:** ${options.tokenBudget} tokens`,
    );

    // 3. Acceptance Criteria
    if (state.acceptanceCriteria.length > 0) {
      sections.push(
        '# Acceptance Criteria\n' + state.acceptanceCriteria.map((ac) => `- [ ] ${ac}`).join('\n'),
      );
    }

    // 4. Progress & State (Done items with cryptographically bound evidence)
    if (state.doneItems.length > 0) {
      sections.push(
        '# Verified Progress (Done Items)\n' +
          state.doneItems
            .map(
              (item) =>
                `- **${item.description}**\n  - Evidence: \`${item.evidence.command}\` (diff ${item.evidence.diffHash.slice(0, 8)}, exit 0)`,
            )
            .join('\n'),
      );
    }

    // 5. Current Plan & Next Action
    if (state.plan.length > 0 || state.nextAction) {
      const planStr =
        state.plan.length > 0 ? state.plan.map((p, i) => `${i + 1}. ${p}`).join('\n') : '';
      sections.push(
        '# Execution Plan\n' +
          (planStr ? `${planStr}\n` : '') +
          (state.nextAction ? `\n**Next Action:** ${state.nextAction}` : ''),
      );
    }

    // 6. Active Typed Facts (Auto-validated against file hashes)
    if (facts.length > 0) {
      sections.push(
        '# Verified Codebase Facts (Active & Hash-Checked)\n' +
          facts
            .map(
              (f) =>
                `- [${f.file}${f.symbol ? `#${f.symbol}` : ''}] ${f.statement} (hash: ${f.fileHash.slice(0, 8)})`,
            )
            .join('\n'),
      );
    }

    // 7. Failed Approaches & Anti-Patterns (Avoid repeating)
    if (failures.length > 0) {
      sections.push(
        '# Failed Attempts (Do Not Repeat)\n' +
          failures
            .map(
              (f) =>
                `- Target: \`${f.target}\`\n  Attempted Approach: ${f.approach}\n  Failure Cause: ${f.error}`,
            )
            .join('\n'),
      );
    }

    // 8. Focused Target Files & Symbols ONLY
    if (options.targetFiles && options.targetFiles.length > 0) {
      const fileBlocks = options.targetFiles.map((file) => {
        const symbolHeader =
          file.symbols && file.symbols.length > 0 ? ` (symbols: ${file.symbols.join(', ')})` : '';
        return `### File: \`${file.path}\`${symbolHeader}\n\`\`\`\n${file.content}\n\`\`\``;
      });
      sections.push('# Focused Workspace Content\n' + fileBlocks.join('\n\n'));
    }

    const fullPrompt = sections.join('\n\n---\n\n');
    const estimated = estimateTokens(fullPrompt);

    return {
      prompt: fullPrompt,
      estimatedTokens: estimated,
      activeFactsCount: facts.length,
    };
  }
}
