# Repomap token benchmark — 2026-11-08

Corpus: `src/core` (non-test .ts) — 69 files, 14,347 LOC, 1,012 definitions, 4,645 references. Engine: tree-sitter. Token counts use omnexx's own `estimateTokens` (~3 chars/token, deliberately conservative).

## 1. Context cost (whole corpus)

| representation                                                 |  tokens | note                                                                                                                                             |
| -------------------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw dump (all files, whole-file ingestion)                     | 175,843 | 69 files                                                                                                                                         |
| omnexx codemap @1000t (current production path)                |     699 | regex outline, no ranking                                                                                                                        |
| Tree-sitter repomap @512t (unseeded)                           |     495 | 4 files, 29/1012 symbols, rank+render 10.8ms                                                                                                     |
| Tree-sitter repomap @1024t (unseeded)                          |     998 | 6 files, 55/1012 symbols, rank+render 5.2ms                                                                                                      |
| Tree-sitter repomap @2048t (unseeded)                          |   2,004 | 10 files, 102/1012 symbols, rank+render 2.0ms                                                                                                    |
| Tree-sitter repomap @1024t (stack-trace seeded, frame pinned)  |     993 | 5 files, 52/1012 symbols, seeds=src/core/token-count.ts,src/agent/context-planner.ts,test/unit/core/token-calibration.test.ts, rank+render 2.2ms |
| call-graph slice from stack trace (maxHops 2, both directions) |   4,095 | gold frame included: yes, 105 spans, truncated: true                                                                                             |
| call-graph slice from stack trace (maxHops 2, callers only)    |   3,374 | gold frame included: yes, 5 spans, truncated: true                                                                                               |

Raw dump → repomap @1024t compresses the corpus to 0.6% of its size (176.2×).
Raw dump → repomap @2048t compresses to 1.1%.
Codemap @1000t baseline vs repomap @1024t: 699 vs 998 tokens.

## 2. Failure-driven retrieval (stack trace seeded)

Seed: `TokenCounter.observeUsage` → gold `src/core/token-count.ts`.

| signal                                               | result                        |
| ---------------------------------------------------- | ----------------------------- |
| rank position of gold file (seeded PPR)              | 1                             |
| gold file in rendered map @1024t, pins off           | yes                           |
| gold file in rendered map @1024t, frame pinned       | yes                           |
| slice tokens @maxHops 2 (both directions)            | 4,095 tokens, truncated: true |
| slice tokens @maxHops 2 (callers only)               | 3,374 tokens, truncated: true |
| tokens if the agent read the whole gold file instead | 2,165                         |

## 3. Retrieval tasks (identifier seed, recall@k / MRR)

| task                 | gold                      | pos (unseed) | pos (seed) | in map (unseed) | in map (seed, no pin) | in map (seed, pinned)* | grep dump tokens | gold file tokens |
| -------------------- | ------------------------- | -----------: | ---------: | --------------- | --------------------- | ---------------------- | ---------------: | ---------------: |
| t1 `TokenCounter`    | `src/core/token-count.ts` |           15 |          1 | no              | yes                   | yes                    |               40 |            2,165 |
| t2 `estimateTokens`  | `src/core/tokens.ts`      |           13 |          1 | no              | yes                   | yes                    |              957 |              824 |
| t3 `nextTokenRatio`  | `src/core/tokens.ts`      |           13 |          1 | no              | yes                   | yes                    |               99 |              824 |
| t4 `AstCache`        | `src/core/ast-cache.ts`   |            1 |          1 | yes             | yes                   | yes                    |               70 |            3,825 |
| t5 `parseFile`       | `src/core/ast-cache.ts`   |            1 |          1 | yes             | yes                   | yes                    |               57 |            3,825 |
| t6 `compactPlanView` | `src/core/plan.ts`        |           25 |          1 | no              | yes                   | yes                    |               37 |            5,833 |
| t7 `writeFileAtomic` | `src/core/atomicWrite.ts` |           26 |          1 | no              | yes                   | yes                    |              517 |              569 |
| t8 `EventLog`        | `src/core/events.ts`      |           19 |          1 | no              | yes                   | yes                    |              163 |            1,477 |

| metric                      | unseeded | seeded |
| --------------------------- | -------: | -----: |
| recall@1                    |    25.0% | 100.0% |
| recall@3                    |    25.0% | 100.0% |
| recall@5                    |    25.0% | 100.0% |
| MRR                         |    0.294 |  1.000 |
| gold in map @1024t (no pin) |    25.0% | 100.0% |

Builtin (regex) engine, same protocol — recall@1 seeded: 50.0%, MRR: 0.667.

## 4. Extraction coverage

| engine                          | definitions found |   time |
| ------------------------------- | ----------------: | -----: |
| tree-sitter                     |             1,012 |  0.60s |
| builtin (regex)                 |             1,140 |  0.14s |
| outline.ts regex (codemap path) |       792 symbols | 30.1ms |

Graph build: 3.7ms. Codemap build+render: 50.2ms.

## Method & caveats

- Token counts are omnexx's `estimateTokens` (chars/3, ceil per call). Real BPE tokenizers differ by ±15%;
  all figures in this file move together, so ratios are stable.
- Edges are sqrt-capped references between files; PageRank is personalized (seeded) with damping 0.85,
  deterministic iteration order, 100 max iterations, L1 tolerance 1e-9.
- "In map" checks look for the `path:` header of the gold file in the rendered output.
- grep dump = every line containing the identifier, `path:line:text`, like `grep -rn`.
- *Pinned column pins the files defining the seeded identifier (the product behavior of `buildRepoMap`); inclusion of those files is guaranteed by construction. The meaningful ranking signal is the no-pin column and the rank positions.
- The corpus is the repo that ships this code; absolute numbers drift as the repo evolves. The ratios
  (raw vs map vs slice) are the deliverable, not the third significant digit.
