# Repository map & context compression

Design + reference implementation for replacing naive whole-file ingestion and unranked outlines
with a compact, ranked, seed-aware symbolic view of the repository. This document is the design
record for the `src/core/repomap/` subsystem; the runnable implementation and its benchmark ship
in the same change.

- **Status**: implemented, benchmarked, unit-tested. Not wired into the live agent loop yet — see
  [Rollout](#10-rollout). Nothing in the existing context pipeline changes behavior.
- **Reproduces**: `npm run bench:repomap` (numbers below come from `bench/repomap/RESULTS.md`).
- **Benchmarks to beat**: `renderCodemap` (production today, unranked regex outline) and raw dumps.

## 1. Problem

Omnexx rebuilds every cycle's context from disk. The cached prefix carries a ~1k-token **codemap**
(`src/agent/codemap.ts`): every tracked file, its path, its line count, and up to 8 regex-matched
symbols per file, filled greedily in git order. It is cheap (~47 ms end-to-end) and it never goes
empty, but it is _unranked_: on a 14k-LOC corpus it shows `token-count.ts` no more plausibly than
`docs`-adjacent utilities, and the reader pays for 1k tokens of undifferentiated outline. A raw
dump is a non-starter: the `src/core` corpus alone is **175,843 tokens** (omnexx's own
`estimateTokens`), roughly 120k words of source in front of every model call.

Measured on the corpus (§8), a **ranked** 1k-token map puts the file you actually need at rank 1
when the task names it — vs rank 15–26 unseeded, and vs no notion of relevance at all in the
codemap. At 2048 tokens the map covers 102/1012 symbols across the 10 highest-rank files instead
of a random walk over everything.

Goals, in order:

1. Cut the context cost of "the model should know the shape of this codebase" by ≥60% versus
   alternatives that carry the same task-critical signal.
2. Make the view **seed-aware**: failures and mentioned identifiers reorder the map.
3. Guarantee visibility of the failure frame, not just rank it highly.
4. Degrade gracefully to a dependency-free regex engine when the tree-sitter WASM backend is
   unavailable.

Non-goals: replacing the lessons/facts/plan memory system; semantic search over embeddings;
type-directed resolution. The map is a _structural_ signal layered on top of those.

## 2. Pipeline

```
                       ┌───────────────────────── src/core/repomap/ ─────────────────────────┐
  repo root ──► extract.ts ──► tree-sitter.ts (queries.ts) ──► tags: defs+refs               │
  (git ls-files ──►        └─► builtin.ts (regex fallback) ─►      │                         │
   fallback walk)                                                   ▼                         │
                                                        graph.ts ──► multigraph (files,      │
                                                              sqrt-capped reference edges)   │
                                                                    ▼                         │
                                              rank.ts ──► personalized PageRank (seeded)      │
                                                                    ▼                         │
                                              render.ts ──► Aider-style collapsed signatures, │
                                                              two-phase pin/rank budget fill  │
                                                                    ▼                         │
                                              slice.ts ──► dependent call-path spans (for     │
                                                              failure-time zoom)              │
                       └──────────────────────────────────────────────────────────────────────┘
```

`index.ts` exports `buildRepoMap(root, options): Promise<BuiltRepoMap>` as the single facade; all
parts are independently exported for the benchmark and tests.

## 3. Tree-sitter symbolic extraction (research item 1)

**Languages**: TypeScript/TSX/JavaScript/JSX, Python, Go — the languages omnexx's target repos
are written in. Every definition captures `name`, `defKind`, `line`, `endLine`, and a **collapsed
signature** (`signature.ts`). Every capture is a single `RepoTag` (`types.ts`).

**Queries** (`queries.ts`) are adapted from Aider's tree-sitter queries (Apache-2.0, attribution
headers kept) with omnexx-specific additions: TS abstract members, enums, interfaces; Python
classes incl. nested, `UPPER_CASE` constants; Go types, interface methods, and structs. References
are captured per language for graph edges (calls, type refs, constructors).

**Signature collapse** — the single highest-leverage detail. Definitions are rendered as _one_
line:

- Normalize whitespace; cut at the **last** top-level `{` (the body brace — an object-typed
  generic like `Promise<{ ast: FileAst } | undefined> {` is kept intact, fixed after smoke-testing
  against this repo); strip trailing `= > ( [ { & | , :`; truncate to `maxSignatureChars` (default 160) with `…`.
- Multi-line parameter lists and generic parameter lists collapse to one line; a trailing `…`
  marks elision.
- Classes/interfaces/enums/structs render the head line only (`class PaymentService`) — members
  are recovered from their own captures if they matter.
- `const`/`let` exports are kept only when the binding looks like a top-level value
  (`DEFAULT_CURRENCY = 'USD'`); function-local consts (`const inner = 1`) are filtered by tracking
  whether the nearest ancestor is a function body.

**Engines and their trade-offs** (measured on the 14,347-LOC corpus, §8.4):

| engine                             | definitions found | wall time | notes                                           |
| ---------------------------------- | ----------------: | --------: | ----------------------------------------------- |
| tree-sitter (WASM)                 |             1,012 |    0.73 s | precise names, kinds, end-lines; drives slicing |
| builtin (regex)                    |             1,140 |    0.13 s | dependency-free; no end-lines; over-captures    |
| `outline.ts` regex (codemap today) |               793 |     27 ms | kindless `kind name` strings, top-level only    |

Builtin's higher count is over-capture (it counts methods and local values the queries exclude);
tree-sitter wins on precision and is the only engine that captures `endLine`, which the slicer
needs. `extractRepository(..., { engine: 'auto' })` (default) tries tree-sitter, falls back to
builtin with `degraded: true` in the result; `engine: 'builtin'` forces the fallback (useful for
CI without WASM assets).

**Backend**: `web-tree-sitter@0.27.2` + `@s-h-a-d-o-w/tree-sitter-wasms@1.0.5` grammars (the
`1.0.13` wasm pack is ABI-incompatible with the installed runtime — do not downgrade). No native
builds; ESM-native; warm-up is one pass per grammar per process.

## 4. Graph centrality & ranking (research item 2)

**Graph** (`graph.ts`): files are nodes (Aider-style). For every definition `d` in file `B` and
reference `r` to `d.name` in file `A ≠ B`, an edge `A → B` is added with weight
`min(occurrences, 20) → sqrt(min(count, 16))`. Self-references and definition-less reference noise
(keywords, builtins) are dropped. Deterministic iteration everywhere (sorted maps, index-stable
heapq-free structures).

**Personalized PageRank** (`rank.ts`): damping 0.85, dangling-node mass redistributed
proportionally to the personalization vector (never uniform — that would leak mass to unseeded
hubs), L1 tolerance 1e-9, ≤100 iterations, single pass, no RNG anywhere. Seeds:

- `seedFiles`: ×50 personalization weight (stack-trace frames, files the task names) —
  _pinned_ in the render (see below), boost not relied on for visibility;
- `seedIdentifiers`: ×25 personalization on files _defining_ that identifier (workspace agents
  overwhelmingly mention identifiers, not paths);
- explicit `personalization: Map<path, weight>` for tests and the benchmark;
- default baseline: every file gets weight 1 (finite teleports to unmentioned files keep the
  ranking honest for small graphs).

**Validation**. Implementation cross-checked against `networkx 3.6.1/scipy` on the dumped
1141-node / 25,810-edge graph of this monorepo: ranks agree to ≤2e-5 (session.ts hub: 0.02163 vs
0.02165; seeded smoke file: 0.013670 both). The implementation is correct; the _phenomenon_ is
real: `src/tui/session.ts` absorbs 807 inbound edge-weight from 447 files while only 67/1139
files have any outbound edge, which flattens unseeded ranks.

**The hub-dilution finding**. Unseeded, the corpus map is dominated by `session.ts`; seeded at
50×/25× the gold file reaches rank 1 in the 69-file corpus but stays at position ~29 in the full
1139-file monorepo (networkx agrees). Raising boosts does not fix it — dilution is structural,
not a tuning problem. Two mitigations, both implemented:

1. **Pin seeded files in the render** (below): guaranteed visibility regardless of rank.
2. **Per-file symbol cap** (`maxSymbolsPerFile`, default 12): one hot file can no longer consume
   100% of the budget; coverage spreads across files. Deterministic: source order.

Ranking is computed once per turn (or per milestone) and reused by every consumer (map, slice,
telemetry). Measured: rank ≈ 2–11 ms on the corpus.

## 5. Dynamic context pruning (research item 3)

`slice.ts` implements two products:

**stack-trace seeds.** `parseStackTrace` handles V8/Node frames (`at Fn (path:line:col)`) and
Python tracebacks (`File "…", line N, in f`), resolves paths relative to the repo root (falling
back to file-name suffix matching), and emits `{kind:'location'}` and `{kind:'symbol'}` seeds.
A failing test becomes a precise 2-seed input for free.

**call-graph slice.** `sliceContext(extractions, texts, { seeds, maxHops, direction, tokenBudget })`
grows outward from the seed spans along reference edges, selecting the _definitions_ whose spans
close over the relevant paths — never whole files. Locations seed the enclosing definition;
symbols seed all same-named definitions (pruning by file when `paths` is given). Direction is
`callers` (who feeds the failure), `callees` (what the failing code needs), or `both`. Each span
is rendered with `path:L<start>-L<end>\n` headers, nearest-first (seed, 1-hop, …), hard-capped by
`tokenBudget` (default 4096); `truncated: true` flags when spans didn't fit. Refs-only (no
full dataflow), matching the Aider-family "no type inference" philosophy; precision is good enough
because seeds are exact symbols from a trace.

Measured: from the failing `observeUsage` frame, `callers` slice = **3,374 tokens, 5 spans**
(gold frame included); `both` = 4,095 tokens / 105 spans and saturates any sane budget on this
hub-heavy graph — prefer `callers` for failure debugging. Compare: reading the gold file whole =
2,165 tokens but carries none of its callers; the map @1024t answers "where is it" in half that.

## 6. Rendering — the compact symbolic view (research item 4 is §9)

`render.ts` produces Aider-style output, token-budgeted with omnexx's conservative estimator:

```
src/core/token-count.ts:
⋮...
│export class TokenCounter
⋮...
│public estimateString(text: string): number
⋮...
│public prefixTokens(messages: readonly Message[]): number[]
src/core/tokens.ts:
⋮...
│export function estimateTokens(text: string): number
⋮ (N more symbols not shown)
```

**Two-phase fill** (this design's addition over Aider's single-pass):

1. **Pin phase** — files in `pinFiles` order (stack frames first, then files defining seeded
   identifiers, capped at 5 total by `buildRepoMap`) render first, capped at
   `pinBudgetFraction` (default **0.5**) of the budget. Pins are the guarantee: seeded frame
   always visible.
2. **Rank phase** — remaining budget filled greedily by rank; per-file integer-token accounting
   (estimateTokens per block, conservative rounding); a file that can't fit even its header is
   skipped and budget continues to the next file (a small high-value file always fits eventually);
   a file that fits _partially_ ends the fill and the `⋮ (N more symbols not shown)` note records
   the remainder.

`maxSymbolsPerFile` (default 12) slices over-long files to their first N top-level symbols,
spreading coverage; the elision note accounts for them. Paths and ordering are deterministic for a
given checkout; the map prefix is rebuilt per cycle, matching the existing codemap lifecycle.

Measured on the corpus @1024t: 6 files, 55/1012 symbols, **998 tokens**; unseeded vs seeded both
honor the budget. Unseeded @512t → 4 files / 29 symbols / 495 tokens.

## 7. API surface & integration points

```ts
import { buildRepoMap } from './src/core/repomap/index.js';

const map = await buildRepoMap(repoRoot, {
  subdir: 'src/core', // optional corpus restriction (POSIX, repo-root relative)
  includeTests: false, // default true — tests are real context for debugging
  seedIdentifiers: ['TokenCounter'], // from the task text / failing assertion
  stackTrace, // raw text; frames + symbol names become seeds
  tokenBudget: 1024,
  maxSymbolsPerFile: 12, // default; spread coverage
  engine: 'auto', // tree-sitter → builtin fallback
});
// map.text | map.tokens | map.ranked | map.index.texts | map.seedCount
```

Wiring sketch (not enabled by default — see §10):

- **Run start / planner cycle 0**: `subdir` unset, `seedIdentifiers` from the goal's noun-phrase
  extraction; result replaces the `codemap` string in `CycleInputs` (same 1k-token slot, same
  `clampSlot`). Cached prefix stable within the run except at milestones.
- **Failure cycles** (after a rejection or gate failure): rebuild with `stackTrace` from parsed
  output; result lives in the **volatile** per-cycle message (not the cached prefix) to avoid
  invalidating the KV cache; the `sliceContext` callers-only output feeds the task-evidence block.
- **Codemap stays** as the always-on, zero-seed baseline; repomap is the ranked, seeded upgrade
  for the same slot. `renderCodemap` remains the fallback when `extractRepository` throws.

Budget placement: `SLOT_CHAR_BUDGETS.codemap` (1,000 × CHARS_PER_TOKEN) is untouched; the map
renders to `estimateTokens` ≤ budget by construction, so the slot clamp never trips.

Determinism: identical checkout + seeds ⇒ byte-identical map text (sorted iteration, no Date/RNG).
This matters for the cached prefix — the codemap was already byte-stable per milestone; the map
preserves that property.

## 8. Measured results

`npm run bench:repomap` (see `bench/repomap/RESULTS.md`; corpus = `src/core` non-test TS:
**69 files, 14,347 LOC, 1,012 defs, 4,645 refs**, extract ≈ 0.6–0.9 s):

### 8.1 Context cost

| representation                              |                        tokens |
| ------------------------------------------- | ----------------------------: |
| Raw dump (whole-corpus ingestion)           |                       175,843 |
| Codemap @1000t (production today)           |                           699 |
| Repomap @512t (unseeded)                    |     495 (4 files, 29 symbols) |
| Repomap @1024t (unseeded)                   |     998 (6 files, 55 symbols) |
| Repomap @2048t (unseeded)                   | 2,004 (10 files, 102 symbols) |
| Repomap @1024t (stack-seeded, frame pinned) |     993 (5 files, 52 symbols) |
| Slice from stack trace, callers, maxHops 2  |               3,374 (5 spans) |
| Gold file read whole                        |                         2,165 |

Raw → map @1024t = **176×** compression (0.6% of tokens). Map vs codemap: +300 tokens @1024t buys
ranking, seeded ordering and definition-granular elision.

### 8.2 Failure-driven retrieval (stack trace → `token-count.ts`)

Seeded PPR rank position of the gold file: **1** (unseeded: 15). Map contains the frame with pins
off and on. Builtin engine on the same protocol: gold file at rank 1 as well _here_, but seeded
recall@1 across the task suite is 50% (vs 100% tree-sitter) — builtin's over-matched references
are a weaker personalization signal.

### 8.3 Retrieval tasks (8 identifier→gold pairs, seeded)

| metric                      | unseeded |     seeded |
| --------------------------- | -------: | ---------: |
| recall@1                    |    25.0% | **100.0%** |
| recall@3                    |    25.0% | **100.0%** |
| recall@5                    |    25.0% | **100.0%** |
| MRR                         |    0.294 |  **1.000** |
| gold in map @1024t (no pin) |    25.0% | **100.0%** |

Pins (buildRepoMap product behavior) make inclusion guaranteed by construction; the no-pin column
shows ranking alone suffices at 1024t on this corpus. Grep dumps for the same identifiers cost
37–957 tokens each, carry no ranking, and flood on common names (`estimateTokens`: 957).

### 8.4 Extraction coverage

| engine        |  defs |      time |
| ------------- | ----: | --------: |
| tree-sitter   | 1,012 | 0.6–0.9 s |
| builtin       | 1,140 |    0.13 s |
| codemap regex |   793 |     27 ms |

Graph build 3.7 ms. Rank+render ≤ 11 ms. Full cold map build ≈ 0.75 s — once per cycle at most,
vs ~47 ms for the codemap; both amortize against a ≥30 s model call.

### 8.5 Caveats

Numbers are omnexx's char/3 estimator (real BPE ±15%); corpus is the repo being shipped, so
things drift; "in map" tests path-header presence; grep baselines are lower bounds on noise. The
_ratios_ (176× compression; seeded-vs-unseeded recall) are the deliverable.

## 9. Diff representation (research item 4)

Three formats, measured on this repo's average change (agent edits ≈ 20–60 lines):

| format                          | example token cost (est.) | adherence evidence (2025–26)                                                                                                | verdict for Omnexx |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| unified diff (`---/+++/@@`)     | ~120–220                  | Degrades sharply on weak models; often 0 exact-match for non-frontier models                                                | fallback only      |
| search-and-replace blocks       | ~150–300                  | Strongest overall exact-match for strong models (Diff-XYZ arXiv:2510.12487); robust to context drift when blocks are unique | **default**        |
| line-number / byte-offset patch | ~60–120 (smallest)        | Fragile to any drift; models miscount lines; needs exact file snapshot at apply time                                        | avoid              |

- Search-replace wins on _adherence_: blocks repeat anchor lines the model just wrote, and the
  applier can hard-fail on non-unique matches (fail-closed, retry with fresh file content in
  evidence). Omnexx's edit tools already enforce uniqueness — keep them, make them the default.
- Unified diff is legitimate when the model is strong and the diff is large (>150 changed lines):
  ~30% cheaper output than re-emitting blocks. Gate on model tier, never on hope.
- Offset patching has the best token economics and the worst production behavior; keep it inside
  deterministic tooling (e.g., AST refactor ops) where offsets are computed, not hallucinated.
- Structure-aware diffs (AST/WS-aware) reach full-code accuracy at >30% lower cost
  (["To Diff or Not to Diff?" arXiv:2604.27296](https://arxiv.org/abs/2604.27296)) — that is a
  serializer optimization for the _output_ path; the repomap is the _input_ path; both compose.

Recommendation: keep search-and-replace as the default edit surface, teach udiff as an optional
per-model-tier output for large edits, never expose offsets to the model. Emit the patch in the
volatile part of the message; the repomap (§7) supplies the anchors the blocks reference.

Related prior art: Aider (repomap; search-replace & udiff both supported), Mentat (ctags-based
map, unranked, manual pinning), SLD-Spec / ARISE / SliceMate (program-slice prompts for LLM spec
& patch generation — same observation as §5: feeding _paths_, not files, preserves recall at a
fraction of the tokens). The omnexx map + slice pair is the same idea wired into a single facade.

## 10. Rollout

1. **Land the subsystem** ✅ shipped: `src/core/repomap/`, tests, benchmark, this doc.
2. **Flag-gated slot swap** ✅ shipped (`REPOMAP_ENABLE=1`, or `true`/`on`; default off). The
   `codemap` string fed into `CycleInputs` is then the ranked map instead of the unranked
   outline. Implementation (`src/core/repomap-slot.ts`): the map is built at run start
   (`initCodemap`) and at milestone boundaries (`settleMilestones`) and persisted as
   `repomap.txt` in the run dir; `loadCodemap` reads that file (building it once if missing)
   and falls back to `renderCodemap` on any failure — the codemap path is untouched when the
   flag is unset. KV-cache contract preserved: the prefix is rebuilt only at the same
   boundaries as the codemap, so it stays byte-identical between milestones. Events:
   `repomap.built` (tokens/files/symbols/engine), `repomap.error` (message; swallowed).
   Not yet covered: the planner's scope view (`src/agent/scopes.ts`) still renders the
   codemap — the flag swaps the worker cycle slot only.
3. **Failure-path zoom** ✅ shipped behind the same flag. When the newest evidence carries a
   parseable V8/Python stack trace, `failureZoomEvidence` renders the dependent call-path
   spans (`sliceContext`, callers, maxHops 2, ≤1,200 tokens) as one extra item in the volatile
   per-cycle evidence — never persisted to the plan, never in the cached prefix, redacted
   like any other snippet. Emits `repomap.failure_zoom`. Example cost: ~800–1,300 tokens on
   the corpus. When there is no stack trace (most cycles), it is a no-op.
4. **Per-model diff adapter** per §9; measure edit-apply failure rate vs the search-replace
   baseline before defaulting anything.
5. **Telemetry to watch** once dogfooded: `cycle.context`/`turn` token classes,
   `repomap.built` tokens vs the codemap's 699, rejection rate and task retries per run,
   prefix cache hit share across a milestone (`cacheReadShare`). Adoption bar: no increase in
   rejections at equal wall-clock, prefix cache hits unchanged vs codemap baseline.
6. Known limits to track: hub-dilution long-tail (consider milestone-scoped pins from the
   plan), tree-sitter WASM memory under very large monorepos (mitigate with `subdir` +
   milestone-scoped rebuilds), Go/Python query gaps vs the TS path.

## Appendix A — defaults

`damping=0.85` · `maxIterations=100` · `tolerance=1e-9` · `seedFileBoost=50` ·
`seedSymbolBoost=25` · `pinBudgetFraction=0.5` · `maxSymbolsPerFile=12` · `maxPinnedFiles=5` ·
`tokenBudget=1024` · `maxSignatureChars=160` · edge weight `sqrt(min(refs,16))`, fan-out cap 20 ·
`estimateTokens` everywhere (chars/3).

## Appendix B — module map

| file             | exports                                                                          | notes                                        |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| `types.ts`       | `RepoTag`, `FileExtraction`, `RepoGraph`, `RankedFile`, `BuildRepoMapOptions`, … | single source of truth                       |
| `queries.ts`     | `QUERIES`, `tagQueryForLanguage`                                                 | Aider-adapted, attribution headers           |
| `tree-sitter.ts` | `TreeSitterExtractor`                                                            | span-map def/name pairing, error recovery    |
| `builtin.ts`     | `BuiltinExtractor`                                                               | regex fallback, no deps                      |
| `signature.ts`   | `collapseSignature`                                                              | last-brace cut, generic-aware                |
| `graph.ts`       | `buildRepoGraph`                                                                 | files-as-nodes multigraph                    |
| `rank.ts`        | `personalizedPageRank`                                                           | seeded PPR, damping redistribution           |
| `render.ts`      | `renderRepoMap`                                                                  | two-phase pin/rank fill                      |
| `slice.ts`       | `sliceContext`, `parseStackTrace`                                                | callers/callees/both, budget cap             |
| `extract.ts`     | `extractRepository`                                                              | git ls-files (root-relative) + walk fallback |
| `index.ts`       | `buildRepoMap`, barrel                                                           | facade used by bench + tests                 |

## References

- Aider repomap: <https://github.com/Aider-AI/aider/blob/main/aider/repomap.py> (files-as-nodes
  personalized PageRank, `sqrt(min(count,16))` weights, chat-files 50× boost — the boost/pin design
  here is its measured successor) and <https://aider.chat/docs/repomap> (~1024-token default map).
- Mentat (ctags map, manual pinning) and its weaker ranking are discussed in prior art; the omnexx
  difference is seeded personalization + guaranteed pins.
- SLD-Spec (<https://arxiv.org/html/2509.09917v2>), ARISE, SliceMate, CoSIL — program slicing as
  context pruning; grounds §5.
- Diff-XYZ (<https://arxiv.org/abs/2510.12487>) and “To Diff or Not to Diff?”
  (<https://arxiv.org/abs/2604.27296>) — ground §9.
- Labels on the tree-sitter WASM packs: `web-tree-sitter@0.27.2` +
  `@s-h-a-d-o-w/tree-sitter-wasms@1.0.5`.
