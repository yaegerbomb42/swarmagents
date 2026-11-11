/**
 * Pre-flight credit estimate for an orchestrator run.
 *
 * Heuristic: each decomposed node costs roughly one planning call plus one
 * execution call. Token counts are estimates — the engine debits the actual
 * usage reported by the model, this is only a gate/warning before the run.
 */
import { getModelPrice } from './modelPricing';

export interface EstimateInput {
  modelId: string;
  nodeCount: number;
  /** Avg input tokens per LLM call. Default 2000. */
  estInputTokensPerCall?: number;
  /** Avg output tokens per LLM call. Default 800. */
  estOutputTokensPerCall?: number;
  /** LLM calls per node (decompose + execute). Default 2. */
  callsPerNode?: number;
}

export interface EstimateResult {
  modelId: string;
  nodeCount: number;
  estCredits: number;
}

export function estimateRunCredits(input: EstimateInput): EstimateResult {
  const {
    modelId,
    nodeCount,
    estInputTokensPerCall = 2000,
    estOutputTokensPerCall = 800,
    callsPerNode = 2,
  } = input;
  const price = getModelPrice(modelId);
  const inCost =
    (estInputTokensPerCall / 1000) * price.creditsPer1KInput * callsPerNode * nodeCount;
  const outCost =
    (estOutputTokensPerCall / 1000) * price.creditsPer1KOutput * callsPerNode * nodeCount;
  return {
    modelId,
    nodeCount,
    estCredits: Math.ceil((inCost + outCost) * 100) / 100,
  };
}

export function hasSufficientBalance(availableCredits: number, estCredits: number): boolean {
  return availableCredits >= estCredits;
}
