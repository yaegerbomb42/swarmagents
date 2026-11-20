/**
 * Shared types for the repository map: AST-driven symbolic indexing, personalized
 * PageRank ranking and call-path slicing.
 *
 * The map is the counterpart of `src/agent/codemap.ts` (a static, query-agnostic outline):
 * it is *ranked* against a seed (the user's prompt, a failing stack trace, the files in the
 * diff) and rendered to a token budget, so the context engine can spend its codemap slot on
 * the symbols that matter for the current task instead of a uniform sampling of the repo.
 *
 * Design notes live in `docs/repomap.md`; the research basis is Aider's RepoMap
 * (tree-sitter tags + personalized PageRank over a file graph), Mentat's ctags-based map,
 * and call-graph slicing as used by polyglot-ast-slicer and ARISE-style fault localization.
 */

/** Kind of a definition, as used for grouping and defKind priors. */
export type DefKind =
  'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'module';

export type TagKind = 'definition' | 'reference';

/**
 * One tag: either a definition site or a use site in a file. References keep the trimmed
 * source line; definitions keep their collapsed signature so rendering never re-reads the
 * file.
 */
export interface RepoTag {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Symbol name (definition name or referenced identifier). */
  readonly name: string;
  readonly kind: TagKind;
  /** Present when `kind === 'definition'`. */
  readonly defKind?: DefKind;
  /** 1-based line where the construct starts. */
  readonly line: number;
  /** 1-based line where the construct ends; equal to `line` for references. */
  readonly endLine: number;
  /** Collapsed signature for definitions; trimmed source line for references. */
  readonly text: string;
}

/** What one file's parse produced. */
export interface FileExtraction {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Language id (`typescript`, `tsx`, `javascript`, `python`, `go`, `unknown`). */
  readonly language: string;
  /** Which extractor produced the tags. */
  readonly engine: 'tree-sitter' | 'builtin';
  readonly tags: readonly RepoTag[];
  /** Module specifiers the file imports (source order, deduplicated). */
  readonly imports: readonly string[];
  /** Set when parsing failed; the file contributes no tags. */
  readonly error?: string;
}

/**
 * The repository graph: files as nodes, weighted references as directed edges.
 * Edge weight between A and B is `sqrt(min(refs(A→B), cap))` so a single hot symbol cannot
 * dominate the ranking (Aider: `sqrt(count)`).
 */
export interface RepoGraph {
  /** All extracted files (repo-relative POSIX), sorted. */
  readonly files: readonly string[];
  /** Outbound edges with sqrt-capped weights. */
  readonly outbound: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Every definition tag, sorted by (path, line, name). */
  readonly definitions: readonly RepoTag[];
  /** Raw (uncapped) cross-file reference counts per edge, for diagnostics. */
  readonly rawEdgeCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Engine(s) used, joined by '+' when mixed. */
  readonly engine: string;
}

export interface RankOptions {
  /** PageRank damping factor. Default 0.85. */
  readonly damping?: number;
  /** Hard cap on power iterations. Default 100. */
  readonly maxIterations?: number;
  /** L1 convergence tolerance across the whole vector. Default 1e-9. */
  readonly tolerance?: number;
  /** Files the user is talking about (open files, changed files, stack-trace files). */
  readonly seedFiles?: readonly string[];
  /** Identifiers in the prompt; files defining them are boosted. */
  readonly seedIdentifiers?: readonly string[];
  /** Personalization boost per seeded file. Default 50 (Aider's added-file weight). */
  readonly seedFileBoost?: number;
  /** Personalization boost per file defining a seeded identifier. Default 25. */
  readonly seedSymbolBoost?: number;
}

export interface RankedFile {
  readonly path: string;
  readonly rank: number;
}

export interface RenderRepoMapOptions {
  /** Token budget for the rendered map. Default 1024 (Aider's default). */
  readonly tokenBudget?: number;
  /** Signatures are cut to this many characters. Default 160. */
  readonly maxSignatureChars?: number;
  /** Append the "⋮ (N more symbols …)" note when the budget forces omissions. Default true. */
  readonly includeOmittedNote?: boolean;
  /**
   * Seeded files guaranteed space in the map, rendered before the ranked remainder in the
   * order given. The whole pinned section is capped at `pinBudgetFraction` of the budget.
   */
  readonly pinFiles?: readonly string[];
  /** Fraction of the budget reserved for pinned files. Default 0.5. */
  readonly pinBudgetFraction?: number;
  /**
   * Maximum symbols rendered per file. Keeps one large hot file from consuming the whole map
   * and spreads coverage across more files. Default 12. Pass `null` to disable the cap.
   */
  readonly maxSymbolsPerFile?: number | null;
}

export interface RenderedRepoMap {
  readonly text: string;
  readonly tokens: number;
  readonly symbolsIncluded: number;
  readonly symbolsTotal: number;
  readonly filesIncluded: number;
  readonly filesTotal: number;
}
