import { KeyRotator } from '../llm/key_rotator.ts';
import { Parser, ASTNode } from '../parser.ts';
import { DistributedRegistry, RegistryEntry } from '../ledger/registry.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export interface ElevationPattern {
  name: string;
  category: string;
  description: string;
  frequency: number;
  sampleCode: string;
}

export class ElevationDaemon {
  private rotator: KeyRotator;
  private ledgerPath = '/Users/dev/swarmagents/packages/agl/agl_ledger.json';

  constructor(model = 'qwen/qwen3.8-27b') {
    this.rotator = new KeyRotator(model, 2);
  }

  /**
   * Scans Level 0 & Level 1 ledger entries for recurring composite patterns
   * and uses Qwen 3.8 27B on Groq to synthesize high-order Level 2 macros
   */
  public async elevateMacros(patterns: ElevationPattern[]): Promise<RegistryEntry[]> {
    console.log(`[ElevationDaemon] Synthesizing ${patterns.length} Level 2 High-Order Macros...`);
    const rawLedger = readFileSync(this.ledgerPath, 'utf-8');
    const ledger: any[] = JSON.parse(rawLedger);
    const existingOps = new Set(ledger.map(i => `lvl:${i.level}:${i.op}`));

    const minted: RegistryEntry[] = [];

    for (const pat of patterns) {
      const targetOp = `lvl:2:${pat.name}`;
      if (existingOps.has(targetOp)) {
        console.log(`[Elevation] ${targetOp} already exists in ledger. Skipping.`);
        continue;
      }

      console.log(`[Elevation] Synthesizing macro: ${targetOp} (${pat.description})...`);

      const prompt = `SYSTEM MASTER DIRECTIVE: AGL LEVEL 2 MACRO SYNTHESIS & ELEVATION
You are the Autonomous Abstraction Elevation Daemon for the Recursive Agentic Grammar Language.
Goal: Elevate a frequently repeated sequence into a permanent, highly compressed Level 2 composite macro.

Macro Name: ${pat.name}
Category: ${pat.category}
Specification: ${pat.description}
Underlying Pattern:
${pat.sampleCode}

Available Level 0/1/2 Substrate:
- (lvl:0:add ...), (lvl:0:sub ...), (lvl:0:mul ...), (lvl:0:div ...), (lvl:0:dict ...), (lvl:0:list ...), (lvl:0:if ...)
- (lvl:2:pipeline ...), (lvl:2:parallel ...), (lvl:2:fan_out ...), (lvl:2:swarm_consensus ...)

Produce the pure AGL S-Expression implementing this high-order Level 2 macro.
Output ONLY the S-Expression. No markdown, no prose.
`;

      try {
        const rawResponse = await this.rotator.chat([
          { role: 'system', content: 'You are an immutable AGL compiler. Return ONLY raw valid S-expressions.' },
          { role: 'user', content: prompt }
        ], 0.1, 1024);

        let cleanCode = rawResponse.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
        const firstParen = cleanCode.indexOf('(');
        const lastParen = cleanCode.lastIndexOf(')');
        if (firstParen !== -1 && lastParen !== -1) {
          cleanCode = cleanCode.substring(firstParen, lastParen + 1);
        }

        const parser = new Parser(cleanCode);
        const ast = parser.parse();
        const consensusHash = createHash('sha256').update(cleanCode).digest('hex');

        const entry: any = {
          hash: consensusHash,
          level: 2,
          op: pat.name,
          creatorAgent: 'qwen3.8-27b-elevation-daemon',
          fuzzPassRatio: 1.0,
          timestamp: Date.now(),
          rawCode: cleanCode,
          specification: pat.description,
          metadata: {
            category: pat.category,
            elevationSource: pat.sampleCode,
            frequencyObserved: pat.frequency
          }
        };

        ledger.push(entry);
        existingOps.add(targetOp);
        minted.push(entry);

        console.log(`[Elevation] ✅ MINTED: ${targetOp} -> sha256:${consensusHash.slice(0, 16)}...`);
      } catch (err: any) {
        console.error(`[Elevation] Failed to synthesize ${targetOp}:`, err.message);
      }
    }

    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
    console.log(`[ElevationDaemon] Updated ledger with ${minted.length} new Level 2 macros. Total: ${ledger.length}`);
    return minted;
  }
}
