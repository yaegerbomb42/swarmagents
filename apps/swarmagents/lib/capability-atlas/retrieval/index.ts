import type { CapabilityEntry } from "../schema";
import { Bm25Index } from "./bm25";
import { LocalEmbedder } from "./embeddings";

export interface CompactCapability {
  id: string;
  kind: CapabilityEntry["kind"];
  risk: CapabilityEntry["risk"];
  summary: string;
  score: number;
}

export interface RetrieverOptions {
  useLocalEmbeddings?: boolean;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class CapabilityRetriever {
  private readonly byId = new Map<string, CapabilityEntry>();
  private readonly bm25: Bm25Index;
  private readonly embedder?: LocalEmbedder;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(
    entries: CapabilityEntry[],
    options: RetrieverOptions = {}
  ) {
    for (const e of entries) this.byId.set(e.id, e);

    this.bm25 = new Bm25Index(
      entries.map((e) => ({
        id: e.id,
        fields: {
          name: e.name,
          summary: e.summary,
          kind: e.kind,
          extra: e.source,
        },
      }))
    );

    if (options.useLocalEmbeddings) {
      this.embedder = new LocalEmbedder(256);
      for (const e of entries) {
        this.vectors.set(e.id, this.embedder.embed(`${e.name} ${e.summary}`));
      }
    }
  }

  find_capability(query: string, k = 5): CompactCapability[] {
    const bm25Hits = this.bm25.search(query, Math.max(k * 3, 15));

    if (!this.embedder) {
      return bm25Hits.slice(0, k).map(({ id, score }) => {
        const entry = this.byId.get(id)!;
        return {
          id: entry.id,
          kind: entry.kind,
          risk: entry.risk,
          summary: entry.summary,
          score: Number(score.toFixed(4)),
        };
      });
    }

    // Hybrid Reciprocal Rank Fusion (BM25 + Local Embeddings)
    const qVec = this.embedder.embed(query);
    const vecHits: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of this.vectors.entries()) {
      const sim = this.embedder.cosine(qVec, vec);
      if (sim > 0.05) vecHits.push({ id, score: sim });
    }
    vecHits.sort((a, b) => b.score - a.score);

    const rrf = new Map<string, number>();
    bm25Hits.forEach((h, idx) => {
      rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1.5 / (60 + idx + 1));
    });
    vecHits.slice(0, Math.max(k * 3, 15)).forEach((h, idx) => {
      rrf.set(h.id, (rrf.get(h.id) ?? 0) + 0.7 / (60 + idx + 1));
    });

    return Array.from(rrf.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id, score]) => {
        const entry = this.byId.get(id)!;
        return {
          id: entry.id,
          kind: entry.kind,
          risk: entry.risk,
          summary: entry.summary,
          score: Number(score.toFixed(4)),
        };
      });
  }

  describe_capability(id: string): CapabilityEntry | null {
    return this.byId.get(id) ?? null;
  }

  formatCompact(results: CompactCapability[]): string {
    if (results.length === 0) return "No matching capabilities found.";
    return results
      .map((r) => `${r.id} | ${r.kind} | ${r.risk} | ${r.summary}`)
      .join("\n");
  }
}
