import { ASTNode } from '../parser.js';

export interface RegistryEntry {
  hash: string;
  level: number;
  op: string;
  ast: ASTNode;
  creatorAgent?: string;
  fuzzPassRatio: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export class DistributedRegistry {
  private entries: Map<string, RegistryEntry> = new Map();
  private aliasMap: Map<string, string> = new Map(); // e.g. "lvl:2:pipeline" -> hash

  public register(entry: RegistryEntry): void {
    if (entry.fuzzPassRatio < 1.0) {
      throw new Error(`Cannot register node ${entry.hash}: Fuzz pass ratio is ${(entry.fuzzPassRatio * 100).toFixed(1)}% (< 100%)`);
    }
    this.entries.set(entry.hash, entry);
    if (entry.op) {
      this.aliasMap.set(`lvl:${entry.level}:${entry.op}`, entry.hash);
    }
  }

  public getByHash(hash: string): RegistryEntry | undefined {
    return this.entries.get(hash);
  }

  public getByAlias(alias: string): RegistryEntry | undefined {
    const hash = this.aliasMap.get(alias);
    if (!hash) return undefined;
    return this.entries.get(hash);
  }

  public toMap(): Map<string, ASTNode> {
    const m = new Map<string, ASTNode>();
    for (const [hash, entry] of this.entries.entries()) {
      m.set(hash, entry.ast);
    }
    return m;
  }

  public listEntries(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }
}
