import { performance } from "node:perf_hooks";
import type { DecisionKind, DecisionRouter, SyntheticDecisionSample } from "./types";

export interface ModelEvalReport {
  model: string;
  synthetic: true;
  totalSamples: number;
  correct: number;
  accuracy: number;
  escalationRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  perClassAccuracy: Record<DecisionKind, { correct: number; total: number; accuracy: number }>;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx]!.toFixed(2));
}

export async function evaluateDecisionRouter(
  model: string,
  router: DecisionRouter,
  dataset: readonly SyntheticDecisionSample[],
): Promise<ModelEvalReport> {
  const latencies: number[] = [];
  let correct = 0;
  let escalated = 0;

  const perClass: Record<DecisionKind, { correct: number; total: number; accuracy: number }> = {
    continue: { correct: 0, total: 0, accuracy: 0 },
    retry: { correct: 0, total: 0, accuracy: 0 },
    ask: { correct: 0, total: 0, accuracy: 0 },
    verify: { correct: 0, total: 0, accuracy: 0 },
    stop: { correct: 0, total: 0, accuracy: 0 },
  };

  for (const sample of dataset) {
    const t0 = performance.now();
    const result = await router.decide(sample.snapshot);
    const dt = performance.now() - t0;
    latencies.push(dt);

    if (result.escalated) escalated++;
    const bucket = perClass[sample.expectedDecision];
    bucket.total++;
    if (result.decision === sample.expectedDecision) {
      correct++;
      bucket.correct++;
    }
  }

  for (const key of Object.keys(perClass) as DecisionKind[]) {
    const b = perClass[key];
    b.accuracy = b.total > 0 ? Number((b.correct / b.total).toFixed(4)) : 0;
  }

  const total = dataset.length;
  return {
    model,
    synthetic: true,
    totalSamples: total,
    correct,
    accuracy: total > 0 ? Number((correct / total).toFixed(4)) : 0,
    escalationRate: total > 0 ? Number((escalated / total).toFixed(4)) : 0,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    perClassAccuracy: perClass,
  };
}
