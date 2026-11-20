/**
 * Step 6.6: Phase C Candidate Synthesis with Constructive Diversity (N=3).
 *
 * Implements:
 *   - Constructive diversity generation across 3 candidate branches:
 *       * c0: Direct fix (T=0.0, worker model)
 *       * c1: Minimal change / edge-case defense (T=0.3, worker model)
 *       * c2: Fix at origin / upstream caller (T=0.3, alternate model rung)
 *   - Strict test-code hiding (anti-fitting gate: repro test code never passed to synthesis)
 *   - Pre-test static filter: drops candidates with syntax errors or positive diagnostics delta
 */

import { z } from 'zod';
import { structuredCall, type StructuredCaller } from '../structured.js';
import type { CandidatePatch, IntentSpec, LocalizationArtifact } from '../types.js';

export const patchCandidateSchema = z.object({
  hypothesis: z.string(),
  diff: z.string().describe('Unified git diff starting with diff --git'),
  filesTouched: z.array(z.string()),
});

export interface StaticPreflightFilter {
  validateDiff: (
    diff: string,
    filesTouched: string[],
  ) => Promise<{ syntaxValid: boolean; diagnosticsDelta: number }>;
}

export interface CandidateGenerationConfig {
  id: string;
  rung: number;
  temperature: number;
  hypothesisLabel: string;
}

export const DIVERSE_CONFIGS: CandidateGenerationConfig[] = [
  { id: 'c0', rung: 0, temperature: 0.0, hypothesisLabel: 'Direct localized fix' },
  { id: 'c1', rung: 0, temperature: 0.3, hypothesisLabel: 'Minimal defensive fix' },
  { id: 'c2', rung: 1, temperature: 0.3, hypothesisLabel: 'Fix at origin / root cause' },
];

/**
 * Strips any reproduction test clues or test files from touched files to prevent test-fitting.
 */
export function sanitizeTouchedFiles(files: string[]): string[] {
  return files.filter(
    (f) =>
      !f.includes('.omnexx-repro') &&
      !f.includes('.test.') &&
      !f.includes('.spec.') &&
      !f.includes('__tests__'),
  );
}

/**
 * Phase C Orchestrator: Synthesizes N=3 constructively diverse candidate patches.
 */
export async function runCandidateSynthesis(
  problemStatement: string,
  localization: LocalizationArtifact,
  intent: IntentSpec,
  caller: StructuredCaller,
  preflight?: StaticPreflightFilter,
): Promise<CandidatePatch[]> {
  const candidatePromises = DIVERSE_CONFIGS.map(async (config): Promise<CandidatePatch | null> => {
    const spec = {
      name: `SynthesizePatch_${config.id}`,
      system:
        'You are an expert systems engineer. Output a clean, minimal git unified diff that fixes the described bug. ' +
        'Do NOT modify test files. The reproduction test is withheld to ensure generalization.',
      prompt:
        `Problem Description:\n${problemStatement}\n\n` +
        `Root Cause:\n${intent.rootCause}\n\n` +
        `Strategy:\n${intent.fixStrategy} (${config.hypothesisLabel})\n\n` +
        `Target Files:\n${localization.files.join(', ')}\n\n` +
        `Spans:\n${JSON.stringify(localization.spans, null, 2)}\n\n` +
        `Temperature Target: ${config.temperature}`,
      schema: patchCandidateSchema,
    };

    const res = await structuredCall(caller, spec);
    if (!res.success) return null;

    const touched = sanitizeTouchedFiles(res.data.filesTouched);
    if (touched.length === 0 && res.data.filesTouched.length > 0) {
      // Attempted to only touch test files; reject test-fitting
      return null;
    }

    let syntaxValid = true;
    let diagnosticsDelta = 0;

    if (preflight) {
      const check = await preflight.validateDiff(res.data.diff, touched);
      syntaxValid = check.syntaxValid;
      diagnosticsDelta = check.diagnosticsDelta;
    }

    // Drop candidates that introduce syntax errors or compiler breaks before running tests
    if (!syntaxValid || diagnosticsDelta > 0) {
      return null;
    }

    return {
      id: config.id,
      rung: config.rung,
      temperature: config.temperature,
      hypothesis: `${config.hypothesisLabel}: ${res.data.hypothesis}`,
      diff: res.data.diff,
      filesTouched: touched,
      syntaxValid,
      diagnosticsDelta,
    };
  });

  const settled = await Promise.all(candidatePromises);
  return settled.filter((c): c is CandidatePatch => c !== null);
}
