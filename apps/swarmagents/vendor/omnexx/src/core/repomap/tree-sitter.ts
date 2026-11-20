/**
 * Tree-sitter backed tag extraction (the preferred engine).
 *
 * Uses `web-tree-sitter` (WASM) plus `@s-h-a-d-o-w/tree-sitter-wasms` (prebuilt grammars for
 * TypeScript/TSX/JavaScript/Python/Go). Both are **optional**: when they are not installed or
 * a grammar fails to load, `TreeSitterExtractor.create()` resolves to `null` and the caller
 * falls back to the dependency-free `BuiltinExtractor`. Nothing in `src/core` hard-depends on
 * the packages — they are devDependencies, loaded via a non-analyzable dynamic import so the
 * `tsup` build leaves the specifier untouched.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Node, Parser, Query, Tree } from 'web-tree-sitter';
import { extractImports } from '../ast-cache.js';
import {
  FUNCTION_LIKE_PARENT_TYPES,
  LANGUAGE_IDS,
  WASM_FILES,
  languageForPath,
  queryFor,
  type LanguageId,
} from './queries.js';
import { collapseReference, collapseSignature } from './signature.js';
import type { DefKind, FileExtraction, RepoTag } from './types.js';

const require = createRequire(import.meta.url);

/** Indirection so neither esbuild/tsup nor the type checker can statically fold the specifier. */
const importPackage = (name: string): Promise<unknown> => import(name);

type ParserCtor = typeof Parser;
interface LanguageCtor {
  load(source: string): Promise<Parameters<Parser['setLanguage']>[0]>;
}
type QueryCtor = new (language: Parameters<Parser['setLanguage']>[0], source: string) => Query;

interface WebTreeSitterModule {
  Parser: ParserCtor & { init(opts?: { locateFile?: (name: string) => string }): Promise<void> };
  Language: LanguageCtor;
  Query: QueryCtor;
}

function asModule(mod: unknown): WebTreeSitterModule | null {
  if (!mod || typeof mod !== 'object') return null;
  const candidate = mod as Record<string, unknown>;
  if (candidate.default && typeof candidate.default === 'object') {
    const nested = asModule(candidate.default);
    if (nested) return nested;
  }
  if (
    typeof candidate.Parser === 'function' &&
    typeof candidate.Language === 'function' &&
    typeof candidate.Query === 'function'
  ) {
    return candidate as unknown as WebTreeSitterModule;
  }
  return null;
}

const DEF_KIND_BY_CAPTURE: Readonly<Record<string, DefKind>> = {
  function: 'function',
  method: 'method',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  module: 'module',
  const: 'const',
};

/** Does the node sit anywhere inside a function-like construct? */
function hasFunctionLikeAncestor(node: Node): boolean {
  let cur: Node | null = node.parent;
  while (cur) {
    if (FUNCTION_LIKE_PARENT_TYPES.has(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

const PYTHON_CONST = /^[A-Z][A-Z0-9_]*$/;

export interface TreeSitterExtractorOptions {
  /** Languages to load. Defaults to everything we ship queries for. */
  readonly languages?: readonly LanguageId[];
}

/**
 * A loaded parser set. Construction is async (grammar WASM compile); extraction is sync and
 * deterministic once constructed.
 */
export class TreeSitterExtractor {
  readonly id = 'tree-sitter' as const;

  private constructor(
    private readonly parsers: ReadonlyMap<LanguageId, Parser>,
    private readonly queries: ReadonlyMap<LanguageId, Query>,
    readonly languages: readonly LanguageId[],
  ) {}

  /** Load the WASM backend. Resolves to null when the optional packages are unavailable. */
  static async create(
    options: TreeSitterExtractorOptions = {},
  ): Promise<TreeSitterExtractor | null> {
    const mod = asModule(await importPackage('web-tree-sitter').catch(() => null));
    if (!mod) return null;
    const { Parser, Language, Query } = mod;
    let coreWasm: string;
    let wasmsDir: string;
    try {
      coreWasm = join(dirname(require.resolve('web-tree-sitter')), 'web-tree-sitter.wasm');
      wasmsDir = join(
        dirname(require.resolve('@s-h-a-d-o-w/tree-sitter-wasms/package.json')),
        'out',
      );
    } catch {
      return null;
    }
    try {
      await Parser.init({ locateFile: () => coreWasm });
    } catch {
      return null;
    }
    const languages = options.languages ?? LANGUAGE_IDS;
    const parsers = new Map<LanguageId, Parser>();
    const queries = new Map<LanguageId, Query>();
    for (const language of languages) {
      try {
        const lang = await Language.load(join(wasmsDir, WASM_FILES[language]));
        const parser = new Parser();
        parser.setLanguage(lang);
        queries.set(language, new Query(lang, queryFor(language)));
        parsers.set(language, parser);
      } catch {
        // A missing or incompatible grammar disables just this language.
      }
    }
    if (parsers.size === 0) return null;
    return new TreeSitterExtractor(parsers, queries, [...parsers.keys()]);
  }

  /** Extract definitions and references from one file. Never throws; errors land on the result. */
  extract(path: string, text: string): FileExtraction {
    const language = languageForPath(path);
    if (!language) {
      return {
        path,
        language: 'unknown',
        engine: 'tree-sitter',
        tags: [],
        imports: [],
        error: 'unsupported-language',
      };
    }
    const parser = this.parsers.get(language);
    const query = this.queries.get(language);
    if (!parser || !query) {
      return {
        path,
        language,
        engine: 'tree-sitter',
        tags: [],
        imports: [],
        error: 'language-unavailable',
      };
    }
    let tree: Tree | null = null;
    try {
      tree = parser.parse(text);
      if (!tree) {
        return {
          path,
          language,
          engine: 'tree-sitter',
          tags: [],
          imports: extractImports(text),
          error: 'parse-failed',
        };
      }
      const tags = this.tagsFromTree(path, text, tree, query, language);
      return { path, language, engine: 'tree-sitter', tags, imports: extractImports(text) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path,
        language,
        engine: 'tree-sitter',
        tags: [],
        imports: extractImports(text),
        error: message,
      };
    } finally {
      tree?.delete();
    }
  }

  private tagsFromTree(
    path: string,
    text: string,
    tree: Tree,
    query: Query,
    language: LanguageId,
  ): RepoTag[] {
    const lines = text.split('\n');
    const captures = query.captures(tree.rootNode) as { name: string; node: Node }[];
    const tags: RepoTag[] = [];
    const seen = new Set<string>();
    const push = (tag: RepoTag): void => {
      const key = `${tag.kind}:${tag.defKind ?? ''}:${tag.name}:${tag.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(tag);
    };

    // Pass 1 — collect definitions indexed by span; pair names in pass 2 via ancestry.
    const defsBySpan = new Map<string, { defKind: DefKind; node: Node }>();
    for (const capture of captures) {
      if (!capture.name.startsWith('definition.')) continue;
      const defKind = DEF_KIND_BY_CAPTURE[capture.name.slice('definition.'.length)];
      if (!defKind) continue;
      const n = capture.node;
      defsBySpan.set(`${n.startIndex}:${n.endIndex}`, { defKind, node: n });
    }
    const paired = new Set<string>();
    for (const capture of captures) {
      if (!capture.name.startsWith('name.definition.')) continue;
      const suffix = capture.name.slice('name.definition.'.length);
      const defKind = DEF_KIND_BY_CAPTURE[suffix];
      if (!defKind) continue;
      const nameNode = capture.node;
      const name = nameNode.text;
      if (defKind === 'const') {
        if (
          hasFunctionLikeAncestor(nameNode) ||
          (language === 'python' && !PYTHON_CONST.test(name))
        ) {
          continue;
        }
      }
      // Innermost enclosing definition of the same kind wins the pairing.
      let defNode: Node | null = nameNode.parent;
      let hit: { defKind: DefKind; node: Node } | undefined;
      while (defNode) {
        const found = defsBySpan.get(`${defNode.startIndex}:${defNode.endIndex}`);
        if (found?.defKind === defKind) {
          hit = found;
          break;
        }
        defNode = defNode.parent;
      }
      if (!hit) continue;
      const spanKey = `${hit.node.startIndex}:${hit.node.endIndex}`;
      const pairKey = `${spanKey}:${name}`;
      if (paired.has(pairKey)) continue;
      paired.add(pairKey);
      const line = hit.node.startPosition.row + 1;
      push({
        path,
        name,
        kind: 'definition',
        defKind,
        line,
        endLine: hit.node.endPosition.row + 1,
        text: collapseSignature(lines, line, 200),
      });
    }

    // Pass 2 — references.
    for (const capture of captures) {
      if (!capture.name.startsWith('name.reference.')) continue;
      const name = capture.node.text;
      if (!name || name.length < 2) continue;
      const row = capture.node.startPosition.row;
      const line = row + 1;
      push({
        path,
        name,
        kind: 'reference',
        line,
        endLine: line,
        text: collapseReference(lines[row] ?? ''),
      });
    }

    tags.sort(
      (a, b) => a.line - b.line || (a.kind === b.kind ? 0 : a.kind === 'definition' ? -1 : 1),
    );
    return tags;
  }
}
