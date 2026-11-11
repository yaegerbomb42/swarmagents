/**
 * Dynamic context pruning by call-graph slicing.
 *
 * Instead of ingesting whole files, `sliceContext` walks the symbol-level call graph from a
 * seed — typically the top frames of a failing stack trace — and returns only the spans of
 * the functions involved, in hop order, under a token budget. A seed symbol covers its whole
 * definition span; callees (and optionally callers) are reached transitively up to `maxHops`.
 *
 * The call graph is built from extraction data, not from the file-rank graph: every reference
 * line inside a definition span belongs to that enclosing definition, and it points at every
 * definition carrying the referenced name (capped). Cross-file edges of that shape are what
 * makes the slice follow the failure rather than the file layout.
 */
import { estimateTokens } from '../tokens.js';
import type { FileExtraction, RepoTag } from './types.js';

export type SliceSeed =
  | { readonly kind: 'symbol'; readonly name: string }
  | { readonly kind: 'location'; readonly path: string; readonly line: number };

export interface SliceOptions {
  readonly seeds: readonly SliceSeed[];
  /** How many call edges to traverse from the seed. Default 2. */
  readonly maxHops?: number;
  /** Which edges to follow from the seed. Default 'both'. */
  readonly direction?: 'callees' | 'callers' | 'both';
  /** Token budget for the rendered slice. Default 4000. */
  readonly tokenBudget?: number;
  /** Max same-name target definitions linked per reference (caps ambiguous fan-out). Default 3. */
  readonly maxDefTargetsPerRef?: number;
}

export interface SliceSpan {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly hop: number;
  readonly symbol: string;
  readonly role: 'seed' | 'callee' | 'caller';
}

export interface SliceResult {
  readonly text: string;
  readonly spans: readonly SliceSpan[];
  readonly tokens: number;
  /** True when the budget cut off part of the reachable set. */
  readonly truncated: boolean;
  readonly seedCount: number;
}

/** Parse a failing stack trace (V8, SpiderMonkey/WebKit, Python) into slice seeds. */
export function parseStackTrace(trace: string, root?: string): SliceSeed[] {
  const seeds: SliceSeed[] = [];
  const seen = new Set<string>();
  const add = (seed: SliceSeed): void => {
    const key = seed.kind === 'symbol' ? `sym:${seed.name}` : `loc:${seed.path}:${seed.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push(seed);
  };
  const toRel = (p: string): string => {
    let out = p.replace(/\\/g, '/');
    if (root) {
      const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (out === r) out = '.';
      else if (out.startsWith(`${r}/`)) out = out.slice(r.length + 1);
    }
    return out.replace(/^file:\/\//, '').replace(/^\.\//, '');
  };
  const patterns: RegExp[] = [
    // V8: "at fn (path:12:34)" or "at path:12:34" or "at new fn (path:12:34)"
    /\bat\s+(?:new\s+)?(?:async\s+)?([A-Za-z_$][\w$<>.]*)?\s*\(?\s*([^()\s]+):(\d+):(\d+)\)?/g,
    // SpiderMonkey/WebKit: "fn@path:12:34"
    /([A-Za-z_$][\w$<>.]*)\s*@([^()\s]+):(\d+):(\d+)/g,
    // Python: 'File "path", line 12, in fn'
    /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+([A-Za-z_]\w*))?/g,
  ];
  for (const raw of trace.split('\n')) {
    const line = raw.trim();
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (re === patterns[0] || re === patterns[1]) {
          const fn = m[1];
          const path = m[2];
          const lineNo = Number(m[3]);
          if (path && Number.isFinite(lineNo)) {
            add({ kind: 'location', path: toRel(path), line: lineNo });
            if (fn && !/^(anonymous|Object|<anonymous>)$/.test(fn)) {
              const simple = fn.split('.').pop();
              if (simple && simple.length >= 2) add({ kind: 'symbol', name: simple });
            }
          }
        } else {
          const path = m[1];
          const lineNo = Number(m[2]);
          if (path && Number.isFinite(lineNo)) {
            add({ kind: 'location', path: toRel(path), line: lineNo });
            if (m[3]) add({ kind: 'symbol', name: m[3] });
          }
        }
      }
    }
  }
  return seeds.slice(0, 20);
}

interface SymbolNode {
  readonly tag: RepoTag;
  readonly id: number;
}

interface Adjacency {
  /** caller node id -> callee node ids */
  readonly forward: Map<number, Set<number>>;
  readonly reverse: Map<number, Set<number>>;
  readonly nodes: readonly SymbolNode[];
  /** Enclosing node of (path, line), or undefined at module scope. */
  enclosing(path: string, line: number): SymbolNode | undefined;
  readonly moduleNode: (path: string) => SymbolNode;
}

function buildAdjacency(
  extractions: readonly FileExtraction[],
  maxDefTargetsPerRef: number,
): Adjacency {
  const nodes: SymbolNode[] = [];
  const moduleNodes = new Map<string, SymbolNode>();
  const pushNode = (tag: RepoTag): SymbolNode => {
    const node = { tag, id: nodes.length };
    nodes.push(node);
    return node;
  };
  const defsByName = new Map<string, SymbolNode[]>();
  for (const extraction of extractions) {
    for (const tag of extraction.tags) {
      if (tag.kind !== 'definition') continue;
      const node = pushNode(tag);
      const bucket = defsByName.get(tag.name);
      if (bucket) bucket.push(node);
      else defsByName.set(tag.name, [node]);
    }
    const modTag: RepoTag = {
      path: extraction.path,
      name: '<module>',
      kind: 'definition',
      defKind: 'module',
      line: 1,
      endLine: Math.max(1, ...extraction.tags.map((t) => t.endLine), 1),
      text: '(module scope)',
    };
    moduleNodes.set(extraction.path, pushNode(modTag));
  }

  const byPath = new Map<string, SymbolNode[]>();
  for (const node of nodes) {
    const bucket = byPath.get(node.tag.path);
    if (bucket) bucket.push(node);
    else byPath.set(node.tag.path, [node]);
  }
  for (const bucket of byPath.values()) {
    bucket.sort((a, b) => a.tag.line - b.tag.line);
  }

  const forward = new Map<number, Set<number>>();
  const reverse = new Map<number, Set<number>>();
  const link = (from: number, to: number): void => {
    if (from === to) return;
    let f = forward.get(from);
    if (!f) forward.set(from, (f = new Set()));
    f.add(to);
    let r = reverse.get(to);
    if (!r) reverse.set(to, (r = new Set()));
    r.add(from);
  };
  const enclosingNode = (path: string, line: number): SymbolNode | undefined => {
    const bucket = byPath.get(path);
    if (!bucket) return undefined;
    let best: SymbolNode | undefined;
    for (const node of bucket) {
      if (node.tag.name === '<module>') continue;
      if (node.tag.line <= line && line <= node.tag.endLine) {
        if (!best || node.tag.endLine - node.tag.line < best.tag.endLine - best.tag.line) {
          best = node;
        }
      }
    }
    return best ?? moduleNodes.get(path);
  };

  for (const extraction of extractions) {
    for (const tag of extraction.tags) {
      if (tag.kind !== 'reference') continue;
      const caller = enclosingNode(extraction.path, tag.line);
      if (!caller) continue;
      const targets = defsByName.get(tag.name) ?? [];
      let linked = 0;
      for (const target of targets) {
        if (linked >= maxDefTargetsPerRef) break;
        if (target.tag.path === caller.tag.path && target.tag.line === caller.tag.line) continue;
        link(caller.id, target.id);
        linked += 1;
      }
    }
  }

  return {
    forward,
    reverse,
    nodes,
    enclosing: enclosingNode,
    moduleNode: (path: string) => {
      const found = moduleNodes.get(path);
      if (found) return found;
      const tag: RepoTag = {
        path,
        name: '<module>',
        kind: 'definition',
        defKind: 'module',
        line: 1,
        endLine: 1,
        text: '(module scope)',
      };
      const node = { tag, id: nodes.length };
      nodes.push(node);
      moduleNodes.set(path, node);
      return node;
    },
  };
}

/**
 * Slice the repository around `options.seeds`. Returns the spans to ingest (ready to paste
 * into a prompt), merged per file when they overlap, hop-ordered, under the token budget.
 */
export function sliceContext(
  extractions: readonly FileExtraction[],
  sources: ReadonlyMap<string, string>,
  options: SliceOptions,
): SliceResult {
  const maxHops = options.maxHops ?? 2;
  const direction = options.direction ?? 'both';
  const tokenBudget = options.tokenBudget ?? 4000;
  const maxDefTargetsPerRef = options.maxDefTargetsPerRef ?? 3;
  const adjacency = buildAdjacency(extractions, maxDefTargetsPerRef);

  // Seed nodes (hop 0).
  const hopOf = new Map<number, number>();
  const roleOf = new Map<number, 'seed' | 'callee' | 'caller'>();
  const seedQueue: number[] = [];
  const enqueue = (nodeId: number, hop: number, role: 'seed' | 'callee' | 'caller'): void => {
    if (hop > maxHops) return;
    const prior = hopOf.get(nodeId);
    if (prior !== undefined && prior <= hop) return;
    hopOf.set(nodeId, hop);
    roleOf.set(nodeId, role);
    seedQueue.push(nodeId);
  };
  let seedCount = 0;
  for (const seed of options.seeds) {
    if (seed.kind === 'symbol') {
      let matched = false;
      for (const node of adjacency.nodes) {
        if (node.tag.kind === 'definition' && node.tag.name === seed.name) {
          enqueue(node.id, 0, 'seed');
          matched = true;
        }
      }
      if (matched) seedCount += 1;
    } else {
      const found = adjacency.enclosing(seed.path, seed.line);
      if (found) {
        enqueue(found.id, 0, 'seed');
        seedCount += 1;
      }
    }
  }

  // BFS over the queue (array iterator sees appended entries — that is the BFS order).
  for (const id of seedQueue) {
    const hop = hopOf.get(id) ?? 0;
    if (hop >= maxHops) continue;
    if (direction !== 'callers') {
      for (const callee of adjacency.forward.get(id) ?? []) {
        enqueue(callee, hop + 1, 'callee');
      }
    }
    if (direction !== 'callees') {
      for (const caller of adjacency.reverse.get(id) ?? []) {
        enqueue(caller, hop + 1, 'caller');
      }
    }
  }

  // Collect spans, order by (hop, path, line), merge per file for rendering.
  const spans: SliceSpan[] = [];
  for (const [nodeId, hop] of hopOf) {
    const node = adjacency.nodes[nodeId];
    if (!node) continue;
    spans.push({
      path: node.tag.path,
      start: node.tag.line,
      end: node.tag.endLine,
      hop,
      symbol: node.tag.name,
      role: roleOf.get(nodeId) ?? 'seed',
    });
  }
  spans.sort((a, b) => a.hop - b.hop || a.path.localeCompare(b.path) || a.start - b.start);

  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  for (const span of spans) {
    const source = sources.get(span.path);
    if (source === undefined) {
      truncated = true;
      continue;
    }
    const lines = source.split('\n');
    const start = Math.max(1, span.start);
    const end = Math.min(lines.length, Math.max(start, span.end));
    const header = `${span.path}:${start}-${end} (${span.symbol}, hop ${span.hop})\n`;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)} ${l}`)
      .join('\n');
    const block = `${header}${body}\n`;
    const cost = estimateTokens(block);
    if (used + cost > tokenBudget) {
      truncated = true;
      continue;
    }
    used += cost;
    sections.push(block);
  }

  const text = sections.join('\n');
  return { text, spans, tokens: estimateTokens(text), truncated, seedCount };
}
