import { tokenize } from "./bm25";

/**
 * Zero-network local character n-gram + token hashing embedder.
 * Produces normalized dense Float32Array vectors for cosine similarity.
 */
export class LocalEmbedder {
  readonly dim: number;

  constructor(dim = 256) {
    this.dim = dim;
  }

  private hash(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  embed(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);

    for (const tok of tokens) {
      const idx = this.hash(tok) % this.dim;
      const sign = (this.hash(`${tok}#s`) & 1) === 0 ? 1 : -1;
      vec[idx] = (vec[idx] ?? 0) + sign * 2.0;

      // Character 3-grams for morphological tolerance (e.g. render/rendering)
      const padded = `^${tok}$`;
      for (let i = 0; i <= padded.length - 3; i++) {
        const gram = padded.slice(i, i + 3);
        const gIdx = this.hash(gram) % this.dim;
        const gSign = (this.hash(`${gram}#g`) & 1) === 0 ? 1 : -1;
        vec[gIdx] = (vec[gIdx] ?? 0) + gSign * 0.5;
      }
    }

    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += (vec[i] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) vec[i] = (vec[i] ?? 0) / norm;
    return vec;
  }

  cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < this.dim; i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return dot;
  }
}
