---
"omnexx": minor
---

Wire the repository map into the agent cycle behind `REPOMAP_ENABLE=1` (default off).

- `src/core/repomap-slot.ts` — `loadCodemap` renders the ranked tree-sitter map instead of the
  unranked regex outline when the flag is set; the map is built at run start and at milestone
  boundaries and persisted as `repomap.txt` in the run dir, preserving the cached-prefix
  byte-stability contract. Any failure falls back to the codemap silently.
- Failure-path zoom: when the newest evidence carries a V8/Python stack trace, the dependent
  call-path spans (callers, maxHops 2, ≤1.2k tokens) are injected as one extra volatile evidence
  item for that cycle — never persisted to the plan.
- New events: `repomap.built`, `repomap.failure_zoom`, `repomap.error`.
- Flag values: `1`/`true`/`on` (case-insensitive). Unset = byte-for-byte the previous behavior.
