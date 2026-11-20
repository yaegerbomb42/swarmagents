---
"omnexx": minor
---

Add `src/core/repomap/`: a tree-sitter repository map (symbolic extraction, files-as-nodes
personalized PageRank, seeded ranking with guaranteed pins) that renders a compact,
budget-fitted, ranked view of the codebase as an alternative to raw dumps and unranked
outlines for the context engine.

- `buildRepoMap(root, { seedIdentifiers, seedFiles, stackTrace, tokenBudget, ... })` returns the
  rendered map (`text`/`tokens`/`filesIncluded`/`symbolsIncluded`), the ranked files and the
  typed extractions. Paths are repo-root-relative (git toplevel when in a git repo).
- Definitions carry collapsed signatures (multi-line generics handled); per-file symbol cap
  (`maxSymbolsPerFile`, default 12) spreads coverage; seeded files pin into up to 50% of the
  budget (`pinBudgetFraction`) so failure frames are always visible.
- `sliceContext` extracts call-path spans around a seed (enclosing definitions for V8/Python
  stack traces included) with a hard token budget — the failure-debugging counterpart to the map.
- Engine chain: tree-sitter WASM (TypeScript/JavaScript, Python, Go) with a dependency-free
  regex fallback (`engine: 'auto' | 'tree-sitter' | 'builtin'`).
- `npm run bench:repomap` reports token cost vs raw dump/codemap and recall@k/MRR on 8
  identifier→file tasks (`bench/repomap/RESULTS.md`); unit tests in `test/unit/core/repomap.test.ts`.
- Design + rollout plan in `docs/repomap.md`. Not wired into the agent loop yet; no behavior change.
