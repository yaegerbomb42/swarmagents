export interface Bm25Document {
  id: string;
  fields: {
    name: string;
    summary: string;
    kind: string;
    extra?: string;
  };
}

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with",
  "from", "and", "or", "is", "are", "be", "this", "that", "it", "my",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9+#.-]+/)
    .flatMap((tok) => {
      const cleaned = tok.replace(/^[.-]+|[.-]+$/g, "");
      if (!cleaned) return [];
      const parts = cleaned.split(/[._-]/).filter(Boolean);
      return parts.length > 1 ? [cleaned, ...parts] : [cleaned];
    })
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export class Bm25Index {
  private readonly docs: Array<{
    id: string;
    tf: Map<string, number>;
    length: number;
  }> = [];
  private readonly df = new Map<string, number>();
  private avgdl = 0;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(documents: Bm25Document[]) {
    let totalLen = 0;
    for (const doc of documents) {
      const tf = new Map<string, number>();
      const addTokens = (text: string, weight: number) => {
        for (const tok of tokenize(text)) {
          tf.set(tok, (tf.get(tok) ?? 0) + weight);
        }
      };

      addTokens(doc.fields.name, 3);
      addTokens(doc.fields.summary, 2);
      addTokens(doc.fields.kind, 1);
      if (doc.fields.extra) addTokens(doc.fields.extra, 1);

      let length = 0;
      for (const [term, count] of tf.entries()) {
        length += count;
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
      totalLen += length;
      this.docs.push({ id: doc.id, tf, length });
    }
    this.avgdl = this.docs.length > 0 ? totalLen / this.docs.length : 1;
  }

  search(query: string, k = 5): Array<{ id: string; score: number }> {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const N = this.docs.length;
    const scores: Array<{ id: string; score: number }> = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const term of qTokens) {
        const freq = doc.tf.get(term) ?? 0;
        if (freq === 0) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const num = freq * (this.k1 + 1);
        const den = freq + this.k1 * (1 - this.b + this.b * (doc.length / this.avgdl));
        score += idf * (num / den);
      }
      if (score > 0) scores.push({ id: doc.id, score });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k);
  }
}
