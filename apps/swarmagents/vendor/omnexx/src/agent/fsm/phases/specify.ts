/**
 * Step 6.5: Phase B Specification & Reproduction Admission.
 *
 * Implements:
 *   - B1: IntentSpec generation (root cause diagnosis, fix strategy, edge cases)
 *   - B2: Reproduction test synthesis & 2-run stability admission gating
 *   - Fallback to reproStatus = "unavailable" when admission criteria fail
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { structuredCall, type StructuredCaller } from '../structured.js';
import type { LocalizationArtifact, IntentSpec, ReproTestArtifact } from '../types.js';

export const intentSpecSchema = z.object({
  rootCause: z.string(),
  fixStrategy: z.string(),
  edgeCases: z.array(z.string()),
});

export const reproTestCandidateSchema = z.object({
  path: z.string(),
  code: z.string(),
  expectedError: z.string(),
});

export type ReproTestCandidate = z.infer<typeof reproTestCandidateSchema>;

export interface ReproTestRunner {
  runOnBaseline: (
    code: string,
    path: string,
  ) => Promise<{ exitCode: number; timedOut: boolean; output: string }>;
}

export interface SpecificationResult {
  intent: IntentSpec;
  repro?: ReproTestArtifact;
  reproStatus: 'reproduced' | 'unavailable';
}

/**
 * B1: Generates the intent specification describing root cause, strategy, and edge cases.
 */
export async function generateIntentSpec(
  problemStatement: string,
  localization: LocalizationArtifact,
  caller: StructuredCaller,
): Promise<IntentSpec> {
  const spec = {
    name: 'IntentSpecification',
    system:
      'Analyze the localized code and provide a root cause analysis, fix strategy, and edge cases.',
    prompt: `Issue:\n${problemStatement}\n\nSuspect files:\n${localization.files.join(', ')}\n\nEdit spans:\n${JSON.stringify(localization.spans, null, 2)}`,
    schema: intentSpecSchema,
  };

  const res = await structuredCall(caller, spec);
  if (res.success) {
    return res.data;
  }

  return {
    rootCause: 'Unresolved symptom described in issue',
    fixStrategy: 'Direct defensive fix at suspect spans',
    edgeCases: ['Null or undefined inputs', 'Empty collections'],
  };
}

/**
 * B2: Generates candidate reproduction tests and admits only tests that stably fail on baseline 2 consecutive runs.
 */
export async function admitReproTest(
  problemStatement: string,
  intent: IntentSpec,
  caller: StructuredCaller,
  runner?: ReproTestRunner,
): Promise<{ repro?: ReproTestArtifact; reproStatus: 'reproduced' | 'unavailable' }> {
  const spec = {
    name: 'ReproTestCandidates',
    system:
      'Generate standalone reproduction tests that reproduce the reported bug by failing on baseline.',
    prompt: `Issue:\n${problemStatement}\n\nIntent:\nRoot Cause: ${intent.rootCause}\nStrategy: ${intent.fixStrategy}`,
    schema: z.object({
      candidates: z.array(reproTestCandidateSchema).min(1).max(3),
    }),
  };

  const res = await structuredCall(caller, spec);
  if (!res.success || !runner) {
    return { reproStatus: 'unavailable' };
  }

  for (const candidate of res.data.candidates) {
    // 2-run stability check: must fail on baseline twice consecutively
    const run1 = await runner.runOnBaseline(candidate.code, candidate.path);
    if (run1.exitCode === 0 || run1.timedOut) {
      continue; // Did not reproduce bug on baseline
    }

    const run2 = await runner.runOnBaseline(candidate.code, candidate.path);
    if (run2.exitCode === 0 || run2.timedOut) {
      continue; // Flaky / inconsistent
    }

    // Both runs stably reproduced the bug!
    const sha256 = createHash('sha256').update(candidate.code).digest('hex');
    return {
      reproStatus: 'reproduced',
      repro: {
        path: candidate.path,
        code: candidate.code,
        sha256,
        admitted: true,
        baselineFailCount: 2,
      },
    };
  }

  return { reproStatus: 'unavailable' };
}

/**
 * Phase B Orchestrator.
 */
export async function runSpecification(
  problemStatement: string,
  localization: LocalizationArtifact,
  caller: StructuredCaller,
  runner?: ReproTestRunner,
): Promise<SpecificationResult> {
  const intent = await generateIntentSpec(problemStatement, localization, caller);
  const reproAdmission = await admitReproTest(problemStatement, intent, caller, runner);

  return {
    intent,
    ...(reproAdmission.repro ? { repro: reproAdmission.repro } : {}),
    reproStatus: reproAdmission.reproStatus,
  };
}
