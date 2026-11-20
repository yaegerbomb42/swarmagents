import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../git/git.js';
import { ScopeTree } from './scope-tree.js';
import {
  type ReturnContract,
  type ScopeTelemetryReport,
  type ScopeTelemetryTurn,
  type TestEvidence,
  type Fact,
} from './types.js';
import { computeDiffHash, mergeChildResult, bindTestEvidence } from './return-contract.js';
import { VerifierScope } from './verifier-scope.js';

export interface RecursiveRunnerOptions {
  repoRoot: string;
  storageDir: string;
  baseBudget?: number;
  runCommand?:
    ((cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>) | undefined;
}

export class RecursiveScopeRunner {
  readonly repoRoot: string;
  readonly storageDir: string;
  readonly baseBudget: number;
  private customRunCommand?:
    ((cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>) | undefined;

  constructor(options: RecursiveRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.storageDir = options.storageDir;
    this.baseBudget = options.baseBudget ?? 32_000;
    this.customRunCommand = options.runCommand;
  }

  private async executeCommand(
    command: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.customRunCommand) {
      return this.customRunCommand(command);
    }
    const [bin, ...args] = command.split(' ');
    if (!bin) return { code: 0, stdout: '', stderr: '' };
    try {
      const res = await git(this.repoRoot, [bin, ...args], { allowFailure: true });
      return { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    } catch (err: unknown) {
      return { code: 1, stdout: '', stderr: String(err) };
    }
  }

  /**
   * Run a recursive scope execution cycle.
   */
  async runTask(params: {
    taskId: string;
    goal: string;
    acceptanceCriteria: string[];
    subProblems: {
      subGoal: string;
      targetFiles: string[];
      targetSymbols?: string[];
      solve: (
        contextPrompt: string,
        budget: number,
      ) => Promise<{
        diff: string;
        facts: { file: string; statement: string; symbol?: string }[];
        tokensUsed: { input: number; output: number };
      }>;
    }[];
    verifyCommand: string;
  }): Promise<{
    solved: boolean;
    report: ScopeTelemetryReport;
    finalDiff: string;
  }> {
    const startTime = Date.now();
    const tree = new ScopeTree(params.goal, params.acceptanceCriteria, {
      storageDir: this.storageDir,
      repoRoot: this.repoRoot,
      baseBudget: this.baseBudget,
    });
    await tree.initRoot();

    const turns: ScopeTelemetryTurn[] = [];
    const readFilesTracker = new Set<string>();
    let reReadCount = 0;
    let totalReads = 0;

    const rootMem = tree.getMemory(tree.root.id);

    // Initial root state build (repo map + goal)
    const rootContext = await rootMem.buildFreshContext({
      inheritedRules: tree.inheritedRules,
      tokenBudget: tree.root.budget,
    });

    turns.push({
      scopeId: tree.root.id,
      depth: 0,
      turn: 1,
      inputTokens: rootContext.estimatedTokens,
      outputTokens: 250,
      totalTokens: rootContext.estimatedTokens + 250,
      filesRead: [],
      isReRead: false,
      timestamp: Date.now(),
    });

    // Execute each sub-problem in a spawned child scope
    for (const sub of params.subProblems) {
      const { node: childNode, request } = await tree.spawnChild(tree.root.id, {
        subGoal: sub.subGoal,
        targetFiles: sub.targetFiles,
        ...(sub.targetSymbols !== undefined ? { targetSymbols: sub.targetSymbols } : {}),
      });

      const childMem = tree.getMemory(childNode.id);

      // Read target files for the child context
      const fileContents: { path: string; content: string; symbols?: string[] }[] = [];
      for (const target of sub.targetFiles) {
        totalReads++;
        if (readFilesTracker.has(target)) {
          reReadCount++;
        } else {
          readFilesTracker.add(target);
        }

        try {
          const content = await readFile(join(this.repoRoot, target), 'utf8');
          fileContents.push({
            path: target,
            content,
            ...(sub.targetSymbols !== undefined ? { symbols: sub.targetSymbols } : {}),
          });
        } catch {
          // File might be newly created by child
        }
      }

      // Build child's FRESH context - NO transcript history!
      const childContext = await childMem.buildFreshContext({
        inheritedRules: request.inheritedRules,
        subGoal: request.subGoal,
        targetFiles: fileContents,
        tokenBudget: request.budget,
      });

      // Child solves sub-problem within its budget
      const solution = await sub.solve(childContext.prompt, request.budget);

      turns.push({
        scopeId: childNode.id,
        depth: childNode.depth,
        turn: turns.length + 1,
        inputTokens: solution.tokensUsed.input,
        outputTokens: solution.tokensUsed.output,
        totalTokens: solution.tokensUsed.input + solution.tokensUsed.output,
        filesRead: sub.targetFiles,
        isReRead: sub.targetFiles.some((f) => readFilesTracker.has(f)),
        timestamp: Date.now(),
      });

      // Record any newly discovered facts
      const recordedFacts: Fact[] = [];
      for (const f of solution.facts) {
        const fact = await childMem.recordFact(f.file, f.statement, f.symbol);
        if (fact) recordedFacts.push(fact);
      }

      // Check test evidence for child
      const childDiffHash = computeDiffHash(solution.diff);
      const testResult = await this.executeCommand(params.verifyCommand);
      const evidence: TestEvidence = bindTestEvidence(
        params.verifyCommand,
        testResult.code,
        testResult.stdout + '\n' + testResult.stderr,
        solution.diff,
      );

      const contract: ReturnContract = {
        scopeId: childNode.id,
        status: testResult.code === 0 ? 'solved' : 'partial',
        diff: solution.diff,
        diffHash: childDiffHash,
        facts: recordedFacts,
        evidence,
      };

      // Discard child context, record compact result
      tree.recordResult(childNode.id, contract);

      // Merge into parent
      await mergeChildResult(rootMem, contract, this.repoRoot);
    }

    // Final Independent Verification Scope
    // Sees ONLY the final diff, the acceptance criteria, and the test output
    const gitDiffRes = await git(this.repoRoot, ['diff'], { allowFailure: true });
    const finalDiff = gitDiffRes.stdout;
    const finalDiffHash = computeDiffHash(finalDiff);

    const finalTestRun = await this.executeCommand(params.verifyCommand);
    const verifierInput = {
      diff: finalDiff,
      diffHash: finalDiffHash,
      acceptanceCriteria: params.acceptanceCriteria,
      testOutput: finalTestRun.stdout + '\n' + finalTestRun.stderr,
      exitCode: finalTestRun.code,
    };

    const verifierVerdict = VerifierScope.verify(verifierInput);

    // Verifier turn telemetry
    const verifierPrompt = VerifierScope.formatVerifierPrompt(verifierInput);
    const verifierTokens = Math.floor(verifierPrompt.length / 4);
    turns.push({
      scopeId: 'verifier',
      depth: 0,
      turn: turns.length + 1,
      inputTokens: verifierTokens,
      outputTokens: 50,
      totalTokens: verifierTokens + 50,
      filesRead: [],
      isReRead: false,
      timestamp: Date.now(),
    });

    const totalTokens = turns.reduce((acc, t) => acc + t.totalTokens, 0);
    const tokensPerTurn = turns.map((t) => t.inputTokens);
    const wallTimeMs = Date.now() - startTime;
    const reReadRatio = totalReads > 0 ? reReadCount / totalReads : 0;

    const report: ScopeTelemetryReport = {
      mode: 'recursive',
      taskId: params.taskId,
      solved: verifierVerdict.verified,
      totalTokens,
      totalTurns: turns.length,
      tokensPerTurn,
      wallTimeMs,
      reReadRatio,
      turns,
    };

    return {
      solved: verifierVerdict.verified,
      report,
      finalDiff,
    };
  }
}
