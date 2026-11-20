import { GroqPool } from '../llm/groq_pool.ts';
import { Parser, ASTNode } from '../parser.ts';
import { Evaluator } from '../runtime/evaluator.ts';
import { ExecutionContext } from '../runtime/context.ts';
import { DistributedRegistry, RegistryEntry } from '../ledger/registry.ts';
import { createHash } from 'node:crypto';

export interface PromotionResult {
  success: boolean;
  ast?: ASTNode;
  hash?: string;
  rejectionReason?: string;
}

export class SynthesisDaemon {
  private pool: GroqPool;
  private evaluator: Evaluator;
  private registry: DistributedRegistry;

  constructor(model = 'qwen/qwen3.8-27b') {
    this.pool = new GroqPool(model);
    this.registry = new DistributedRegistry();
    this.evaluator = new Evaluator(this.registry.toMap());
  }

  public getRegistry(): DistributedRegistry {
    return this.registry;
  }

  /**
   * 4-Stage Autonomous Pipeline:
   * 1. Generation (Candidate executable body from specification using lower level primitives)
   * 2. Static Parsing & Hash Minting
   * 3. Multi-Agent Adversarial Review (Logic + Security + Performance)
   * 4. Multi-State Fuzz Execution
   * 5. Consensus Hash Minting & Promotion
   */
  public async synthesizeAndPromote(
    targetLevel: number,
    opName: string,
    specification: string
  ): Promise<PromotionResult> {
    console.log(`\n[Stage 1: Generation] Requesting candidate body for lvl:${targetLevel}:${opName} using Groq...`);

    const genPrompt = `SYSTEM MASTER DIRECTIVE: RECURSIVE AGENT-NATIVE LANGUAGE (AGL)
You are an autonomous compiler synthesizing an AGL (Agentic Grammar Language) expression.
Grammar Rules:
- S-Expression format: (lvl:<N>:<operator> <arguments...>)
- Base L0 primitives available:
  (lvl:0:add a b), (lvl:0:sub a b), (lvl:0:mul a b), (lvl:0:div a b), (lvl:0:eq a b), (lvl:0:gt a b), (lvl:0:lt a b), (lvl:0:not a), (lvl:0:concat a b), (lvl:0:get key), (lvl:0:set key val), (lvl:0:if cond t f), (lvl:0:list ...), (lvl:0:len a)
- Context variables provided as arguments during evaluation: $a, $b.
- Zero human markdown, zero conversational commentary.
- Return ONLY the executable S-Expression combining the L0 primitives that implements the specification.

Specification: ${specification}

Example output format:
(lvl:0:add (lvl:0:mul $a $a) $b)
`;

    const rawCandidate = await this.pool.chatCompletion([
      { role: 'system', content: 'You are an immutable AGL compiler. Output ONLY valid AGL S-expression with no markdown.' },
      { role: 'user', content: genPrompt }
    ]);

    const cleanedCode = this.extractAGLExpression(rawCandidate);
    console.log(`[Stage 1 Candidate Generated]:\n${cleanedCode}`);

    // Stage 2: Static Constraint & Parsing
    console.log(`[Stage 2: Static Parse & AST Fingerprint]`);
    let ast: ASTNode;
    try {
      const parser = new Parser(cleanedCode);
      ast = parser.parse();
    } catch (err: any) {
      return { success: false, rejectionReason: `Parse Error: ${err.message}` };
    }

    // Stage 3: Multi-Agent Adversarial Review
    console.log(`[Stage 3: Multi-Agent Adversarial Review]`);
    const reviewPrompt = `Evaluate the following AGL Candidate AST:
${cleanedCode}

Perform 3 audits:
1. Logic Validator (deadlocks, infinite loops, unbound recursion)
2. Security Auditor (unauthorized memory or privilege violation)
3. Performance Profiler (token and compute bounds)

Answer in EXACT format:
AUDIT_STATUS: PASS or FAIL
REASON: <concise reason>`;

    const auditRes = await this.pool.chatCompletion([
      { role: 'system', content: 'You are an adversarial multi-agent auditor for AGL code.' },
      { role: 'user', content: reviewPrompt }
    ], 0.0);

    console.log(`[Stage 3 Review Verdict]:\n${auditRes.trim()}`);
    if (auditRes.includes('AUDIT_STATUS: FAIL')) {
      return {
        success: false,
        rejectionReason: `Adversarial Audit Failed: ${auditRes}`
      };
    }

    // Stage 4: Fuzz Testing
    console.log(`[Stage 4: Synthetic State Fuzz Testing (100 runs)]`);
    let passedRuns = 0;
    const totalRuns = 100;

    for (let i = 0; i < totalRuns; i++) {
      const ctx = new ExecutionContext();
      ctx.set('$a', Math.floor(Math.random() * 50) + 1);
      ctx.set('$b', Math.floor(Math.random() * 50) + 1);
      ctx.set('$str', `state_${i}`);

      try {
        const val = await this.evaluator.evaluate(ast, ctx);
        if (typeof val === 'number' && !isNaN(val)) {
          passedRuns++;
        }
      } catch (err) {
        break;
      }
    }

    const passRatio = passedRuns / totalRuns;
    console.log(`[Stage 4 Result]: Pass Ratio = ${(passRatio * 100).toFixed(1)}% (${passedRuns}/${totalRuns})`);

    if (passRatio < 1.0) {
      return {
        success: false,
        rejectionReason: `Fuzz test failed (${passedRuns}/${totalRuns} passed)`
      };
    }

    // Stage 5: Consensus Hash Minting & Promotion
    const consensusHash = createHash('sha256').update(cleanedCode).digest('hex');
    const entry: RegistryEntry = {
      hash: consensusHash,
      level: targetLevel,
      op: opName,
      ast,
      creatorAgent: 'qwen3.8-27b-swarm',
      fuzzPassRatio: passRatio,
      timestamp: Date.now(),
      metadata: { rawCode: cleanedCode, specification }
    };

    this.registry.register(entry);
    console.log(`[Stage 5: Minted & Promoted] Hash: sha256:${consensusHash}`);

    return {
      success: true,
      ast,
      hash: consensusHash
    };
  }

  private extractAGLExpression(raw: string): string {
    let clean = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    const firstParen = clean.indexOf('(');
    const lastParen = clean.lastIndexOf(')');
    if (firstParen !== -1 && lastParen !== -1 && lastParen > firstParen) {
      clean = clean.substring(firstParen, lastParen + 1);
    }
    return clean;
  }
}
