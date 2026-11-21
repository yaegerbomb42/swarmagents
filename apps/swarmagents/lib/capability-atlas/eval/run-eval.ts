import { CapabilityRetriever, estimateTokens } from "../retrieval/index";
import { FIXTURE_MACHINE_CAPABILITIES } from "./fixtures";
import { EVAL_TASKS } from "./tasks";

export interface EvalReport {
  total: number;
  top3Hits: number;
  top3Accuracy: number;
  avgTokens: number;
  misses: Array<{ query: string; got: string[]; expected: string[] }>;
}

export function runRetrievalEval(k = 3): EvalReport {
  const retriever = new CapabilityRetriever(FIXTURE_MACHINE_CAPABILITIES, {
    useLocalEmbeddings: true,
  });

  let top3Hits = 0;
  let totalTokens = 0;
  const misses: EvalReport["misses"] = [];

  for (const task of EVAL_TASKS) {
    const results = retriever.find_capability(task.query, k);
    const formatted = retriever.formatCompact(results);
    totalTokens += estimateTokens(formatted);

    const gotIds = results.map((r) => r.id);
    const hit = task.expectedIds.some((id) => gotIds.includes(id));
    if (hit) {
      top3Hits++;
    } else {
      misses.push({ query: task.query, got: gotIds, expected: task.expectedIds });
    }
  }

  return {
    total: EVAL_TASKS.length,
    top3Hits,
    top3Accuracy: top3Hits / EVAL_TASKS.length,
    avgTokens: Number((totalTokens / EVAL_TASKS.length).toFixed(1)),
    misses,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runRetrievalEval(3);
  console.log(
    `Top-3 Accuracy: ${(report.top3Accuracy * 100).toFixed(1)}% (${report.top3Hits}/${report.total})`
  );
  console.log(`Avg Tokens/Lookup: ${report.avgTokens}`);
  if (report.misses.length > 0) {
    console.log("Misses:", report.misses);
  }
}
