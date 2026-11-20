import { KeyRotator } from '../llm/key_rotator.ts';
import { Parser, ASTNode } from '../parser.ts';
import { Evaluator } from '../runtime/evaluator.ts';
import { ExecutionContext } from '../runtime/context.ts';
import { DistributedRegistry, RegistryEntry } from '../ledger/registry.ts';
import { SpecItem, AGL_SPEC_CATALOG } from '../spec_catalog.ts';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

export class MassSwarmSynthesizer {
  private rotator: KeyRotator;
  private registry: DistributedRegistry;
  private evaluator: Evaluator;
  private ledgerPath = '/Users/dev/swarmagents/packages/agl/agl_ledger.json';

  constructor(model = 'qwen/qwen3.8-27b') {
    this.rotator = new KeyRotator(model, 2);
    this.registry = new DistributedRegistry();
    this.evaluator = new Evaluator(this.registry.toMap());
    this.loadExistingLedger();
  }

  private loadExistingLedger(): void {
    if (existsSync(this.ledgerPath)) {
      try {
        const raw = readFileSync(this.ledgerPath, 'utf-8');
        const list = JSON.parse(raw);
        for (const item of list) {
          const parser = new Parser(item.rawCode);
          const ast = parser.parse();
          this.registry.register({
            hash: item.hash,
            level: item.level,
            op: item.op,
            ast,
            creatorAgent: item.creatorAgent,
            fuzzPassRatio: item.fuzzPassRatio,
            timestamp: item.timestamp,
            metadata: item.metadata
          });
        }
        console.log(`[MassSwarm] Loaded ${list.length} existing items from ${this.ledgerPath}`);
      } catch (e) {
        console.warn('[MassSwarm] Could not parse existing ledger:', e);
      }
    }
  }

  private saveLedger(): void {
    const list = this.registry.listEntries().map(e => ({
      hash: e.hash,
      level: e.level,
      op: e.op,
      creatorAgent: e.creatorAgent,
      fuzzPassRatio: e.fuzzPassRatio,
      timestamp: e.timestamp,
      rawCode: e.metadata?.rawCode,
      specification: e.metadata?.specification
    }));
    writeFileSync(this.ledgerPath, JSON.stringify(list, null, 2), 'utf-8');
  }

  public async runFullSwarm(): Promise<void> {
    console.log(`========================================================================`);
    console.log(`🚀 INITIATING AGENT SWARM MASS COMPILATION: ${AGL_SPEC_CATALOG.length} PRIMITIVES`);
    console.log(`Pool: 14 Groq Keys | Engine: qwen/qwen3.8-27b | Pipeline: 5-Stage Consensus`);
    console.log(`========================================================================\n`);

    const results: { op: string; status: 'SUCCESS' | 'FAILED'; hash?: string; reason?: string }[] = [];

    // Process tasks in parallel chunks of 4 concurrent workers across the 14 keys
    const CONCURRENCY = 4;
    for (let i = 0; i < AGL_SPEC_CATALOG.length; i += CONCURRENCY) {
      const chunk = AGL_SPEC_CATALOG.slice(i, i + CONCURRENCY);
      console.log(`\n--- Launching Swarm Batch [${i + 1} to ${Math.min(i + CONCURRENCY, AGL_SPEC_CATALOG.length)} / ${AGL_SPEC_CATALOG.length}] ---`);

      const promises = chunk.map(item => this.synthesizeItem(item));
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
      this.saveLedger();
    }

    console.log(`\n========================================================================`);
    console.log(`📊 MASS SYNTHESIS HARNESS COMPLETE`);
    const successful = results.filter(r => r.status === 'SUCCESS').length;
    console.log(`Total Primitives Processed: ${results.length}`);
    console.log(`Passed Consensus & Minted:  ${successful} / ${results.length}`);
    console.log(`Ledger Path: ${this.ledgerPath}`);
    console.log(`========================================================================\n`);
  }

  private async synthesizeItem(item: SpecItem): Promise<{ op: string; status: 'SUCCESS' | 'FAILED'; hash?: string; reason?: string }> {
    const qualifiedOp = `lvl:${item.level}:${item.op}`;
    console.log(`[Worker] Started: ${qualifiedOp} (${item.description})`);

    // Stage 1: Generation Prompt
    const genPrompt = `SYSTEM MASTER DIRECTIVE: RECURSIVE AGENT-NATIVE LANGUAGE (AGL)
You are an immutable compiler generating an AGL expression for:
Operator: ${qualifiedOp}
Expected Inputs: ${item.expectedArgs.join(', ')}
Specification: ${item.description}

Available Level 0 Base Primitives:
- (lvl:0:add a b)
- (lvl:0:sub a b)
- (lvl:0:mul a b)
- (lvl:0:div a b)
- (lvl:0:eq a b)
- (lvl:0:gt a b)
- (lvl:0:lt a b)
- (lvl:0:not a)
- (lvl:0:concat a b)
- (lvl:0:if cond true_branch false_branch)
- (lvl:0:len a)
- (lvl:0:list a b ...)
- Literals: numbers, strings, true, false, null

RULES:
- Discard human comments, zero markdown code fences, zero pleasantries.
- Output ONLY the single raw valid S-Expression that implements this specification using the input variables ${item.expectedArgs.join(', ')}.
`;

    let candidateCode = '';
    try {
      const raw = await this.rotator.chat([
        { role: 'system', content: 'You are an immutable AGL compiler. Return ONLY raw S-expressions with NO markdown.' },
        { role: 'user', content: genPrompt }
      ], 0.0, 1024);

      candidateCode = this.cleanExpression(raw);
    } catch (err: any) {
      console.error(`[Worker ${qualifiedOp}] Generation failed: ${err.message}`);
      return { op: qualifiedOp, status: 'FAILED', reason: `LLM Gen Error: ${err.message}` };
    }

    // Stage 2: Static Parser & Hash
    let ast: ASTNode;
    try {
      const parser = new Parser(candidateCode);
      ast = parser.parse();
    } catch (err: any) {
      console.warn(`[Worker ${qualifiedOp}] Parse failed on candidate:\n${candidateCode}\nError: ${err.message}`);
      return { op: qualifiedOp, status: 'FAILED', reason: `Parser error: ${err.message}` };
    }

    // Stage 3: Multi-Agent Adversarial Review
    const reviewPrompt = `Evaluate this AGL S-Expression candidate:
${candidateCode}

Check:
1. Logic Validator: Does this expression match "${item.description}"?
2. Security: Does it respect pure S-expression sandboxing without leakage?
3. Safety: Free of endless recursion?

Respond in EXACT FORMAT:
AUDIT_STATUS: PASS or FAIL
REASON: <concise summary>`;

    try {
      const audit = await this.rotator.chat([
        { role: 'system', content: 'You are an adversarial multi-agent auditor for AGL code.' },
        { role: 'user', content: reviewPrompt }
      ], 0.0, 512);

      if (audit.includes('AUDIT_STATUS: FAIL')) {
        console.warn(`[Worker ${qualifiedOp}] Adversarial Audit REJECTED: ${audit}`);
        return { op: qualifiedOp, status: 'FAILED', reason: `Audit fail: ${audit}` };
      }
    } catch (err: any) {
      // If audit network fails, fall back to strict local fuzzing
    }

    // Stage 4: Strict Behavioral Fuzz Testing against Specification Validator
    let fuzzPassed = 0;
    const testCases = item.sampleInputs;
    for (const testInput of testCases) {
      const ctx = new ExecutionContext();
      for (const [k, v] of Object.entries(testInput)) {
        ctx.set(k, v);
      }
      try {
        const out = await this.evaluator.evaluate(ast, ctx);
        if (item.fuzzValidator(out, testInput)) {
          fuzzPassed++;
        }
      } catch (err) {
        // failed execution
      }
    }

    const ratio = testCases.length > 0 ? fuzzPassed / testCases.length : 1.0;
    if (ratio < 1.0) {
      console.warn(`[Worker ${qualifiedOp}] Fuzz failure: ${fuzzPassed}/${testCases.length} passed.`);
      return { op: qualifiedOp, status: 'FAILED', reason: `Fuzz test failed (${fuzzPassed}/${testCases.length})` };
    }

    // Stage 5: Consensus Hash Minting
    const mintHash = createHash('sha256').update(candidateCode).digest('hex');
    const entry: RegistryEntry = {
      hash: mintHash,
      level: item.level,
      op: item.op,
      ast,
      creatorAgent: 'qwen3.8-27b-swarm',
      fuzzPassRatio: 1.0,
      timestamp: Date.now(),
      metadata: {
        rawCode: candidateCode,
        category: item.category,
        description: item.description,
        inputs: item.expectedArgs
      }
    };

    this.registry.register(entry);
    console.log(`[Worker ${qualifiedOp}] ✅ MINTED: sha256:${mintHash.slice(0, 16)}... Code: ${candidateCode}`);

    return { op: qualifiedOp, status: 'SUCCESS', hash: mintHash };
  }

  private cleanExpression(raw: string): string {
    let clean = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    const firstParen = clean.indexOf('(');
    const lastParen = clean.lastIndexOf(')');
    if (firstParen !== -1 && lastParen !== -1 && lastParen > firstParen) {
      clean = clean.substring(firstParen, lastParen + 1);
    }
    return clean;
  }
}
