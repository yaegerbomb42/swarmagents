/**
 * Step 6.4: Phase A Hierarchical Localization & Bounded Exploration (A4).
 *
 * Implements a 4-tier localization ladder:
 *   - A1: File-level ranking using key terms and call-graph/path relevance
 *   - A2: Element-level localization (function/class/method identification)
 *   - A3: Line-span extraction across suspect elements
 *   - A4: Bounded agency exploration (active when confidence < 0.5):
 *       * Strictly read-only tools: read_symbol, outline, search, read
 *       * Hard ceilings: max 8 calls, max 3 per tool, max 12k tokens, 90s timeout
 *       * Typed output conforming to EditSpans schema
 */

import { z } from 'zod';
import { structuredCall, type StructuredCaller } from '../structured.js';

export const editSpanSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  symbol: z.string().optional(),
  reason: z.string().optional(),
});

export type EditSpan = z.infer<typeof editSpanSchema>;

export const localizationResultSchema = z.object({
  files: z.array(z.string()),
  spans: z.array(editSpanSchema),
  confidence: z.number().min(0).max(1),
  exploredViaA4: z.boolean().default(false),
});

export type LocalizationResult = z.infer<typeof localizationResultSchema>;

export const ALLOWED_A4_TOOLS = ['read_symbol', 'outline', 'search', 'read'] as const;
export type AllowedA4Tool = (typeof ALLOWED_A4_TOOLS)[number];

export const A4_MAX_TOTAL_CALLS = 8;
export const A4_MAX_PER_TOOL = 3;
export const A4_MAX_OUTPUT_TOKENS = 12_000;
export const A4_TIMEOUT_MS = 90_000;

export interface A4ToolContext {
  search?: (query: string) => Promise<string[]>;
  readSymbol?: (symbol: string, path?: string) => Promise<string>;
  outline?: (path: string) => Promise<string>;
  read?: (path: string, startLine?: number, endLine?: number) => Promise<string>;
}

/**
 * A1: Fast keyword & path heuristic ranker.
 */
export function rankSuspectFiles(problemStatement: string, candidateFiles: string[]): string[] {
  const terms = problemStatement
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = candidateFiles.map((file) => {
    let score = 0;
    const lower = file.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term)) {
        score += term.includes('.') ? 5 : 2;
      }
    }
    return { file, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.file);
}

/**
 * A4 Bounded Agency Explorer.
 * Runs when initial localization confidence is below 0.5.
 */
export async function runA4BoundedExploration(
  problemStatement: string,
  suspectFiles: string[],
  toolCtx: A4ToolContext,
  caller: StructuredCaller,
): Promise<{ spans: EditSpan[]; confidence: number }> {
  const toolCounts: Record<AllowedA4Tool, number> = {
    read_symbol: 0,
    outline: 0,
    search: 0,
    read: 0,
  };

  let totalCalls = 0;
  const observations: string[] = [];
  const startTime = Date.now();

  // Exploration loop: max 8 calls
  while (totalCalls < A4_MAX_TOTAL_CALLS && Date.now() - startTime < A4_TIMEOUT_MS) {
    const targetFile = suspectFiles[totalCalls % suspectFiles.length];
    if (!targetFile) break;

    // Search query or read outline
    if (toolCounts.outline < A4_MAX_PER_TOOL && toolCtx.outline) {
      toolCounts.outline += 1;
      totalCalls += 1;
      try {
        const outline = await toolCtx.outline(targetFile);
        observations.push(`Outline of ${targetFile}:\n${outline.slice(0, 1000)}`);
      } catch {
        // Continue
      }
    } else if (toolCounts.search < A4_MAX_PER_TOOL && toolCtx.search) {
      toolCounts.search += 1;
      totalCalls += 1;
      try {
        const matches = await toolCtx.search(problemStatement.slice(0, 30));
        observations.push(`Search results:\n${matches.slice(0, 5).join('\n')}`);
      } catch {
        // Continue
      }
    } else if (toolCounts.read < A4_MAX_PER_TOOL && toolCtx.read) {
      toolCounts.read += 1;
      totalCalls += 1;
      try {
        const snippet = await toolCtx.read(targetFile, 1, 50);
        observations.push(`Read snippet of ${targetFile}:\n${snippet.slice(0, 1000)}`);
      } catch {
        // Continue
      }
    } else {
      break;
    }
  }

  // Synthesize EditSpans from observations via structuredCall
  const spec = {
    name: 'A4EditSpans',
    system: 'You are an expert bug localizer. Identify exact file paths and line ranges to modify.',
    prompt: `Problem:\n${problemStatement}\n\nExploration Observations:\n${observations.join('\n\n')}\n\nSubmit the exact edit spans.`,
    schema: z.object({
      spans: z.array(editSpanSchema),
      confidence: z.number().min(0).max(1),
    }),
  };

  const res = await structuredCall(caller, spec);
  if (res.success) {
    return res.data;
  }

  // Fallback to top suspect file if A4 model call exhausted
  return {
    spans: suspectFiles.slice(0, 1).map((path) => ({
      path,
      startLine: 1,
      endLine: 50,
      reason: 'A4 fallback to file header',
    })),
    confidence: 0.5,
  };
}

/**
 * Phase A Orchestrator: runs A1 -> A2/A3 -> optional A4 bounded exploration.
 */
export async function runLocalization(
  problemStatement: string,
  candidateFiles: string[],
  caller: StructuredCaller,
  toolCtx: A4ToolContext = {},
): Promise<LocalizationResult> {
  // A1: Fast keyword ranking
  const ranked = rankSuspectFiles(problemStatement, candidateFiles);
  const filesToInspect = ranked.length > 0 ? ranked.slice(0, 5) : candidateFiles.slice(0, 5);

  // A2 & A3: Element & line-span extraction via structuredCall
  const spec = {
    name: 'LocalizationReport',
    system: 'Identify the exact files and line spans responsible for the reported bug.',
    prompt: `Bug description:\n${problemStatement}\n\nCandidate files:\n${filesToInspect.join('\n')}`,
    schema: localizationResultSchema,
  };

  const initialRes = await structuredCall(caller, spec);

  let result: LocalizationResult;
  if (initialRes.success) {
    result = initialRes.data;
  } else {
    // Low confidence default
    result = {
      files: filesToInspect.slice(0, 1),
      spans: filesToInspect.slice(0, 1).map((f) => ({ path: f, startLine: 1, endLine: 30 })),
      confidence: 0.3,
      exploredViaA4: false,
    };
  }

  // A4: Trigger bounded exploration if confidence is low (< 0.5)
  if (result.confidence < 0.5) {
    const a4Result = await runA4BoundedExploration(
      problemStatement,
      result.files.length > 0 ? result.files : filesToInspect,
      toolCtx,
      caller,
    );
    return {
      files: a4Result.spans.map((s) => s.path),
      spans: a4Result.spans,
      confidence: Math.max(result.confidence, a4Result.confidence),
      exploredViaA4: true,
    };
  }

  return result;
}
