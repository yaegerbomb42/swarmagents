# vendor/: reference snapshots (pending step 2)

Earlier projects were brought into SwarmAgents as plain source snapshots so the useful parts can be ported
into the app by pull request. Nothing in the app imports from here, and this folder is excluded from the app's
typecheck, lint, tests and Docker build context.

| Folder | What it is | Snapshot |
| --- | --- | --- |
| `omnexx/` | Omnexx: autonomous coding agent CLI + VS Code extension (TypeScript, 1.0.0) | from the former standalone repo, `main@fac3784` |
| `swarmagents-repo/` | Leftovers from the old standalone `swarmagents` repo not found elsewhere here (role registry, key clusters, racing engine, UI ideas, engine patch); see its README | `yaegerbomb42/swarmagents` `main@d4712b6` |

Plan: for each useful piece, open a PR that ports it into `apps/swarmagents/lib/...` (with tests), and delete the
vendored folder once nothing is left worth keeping.

Already ported:
- From `claude-code-mini/` (now mined and removed): context governor and AST slicer (`lib/harness/context/`), log condenser (`lib/harness/log-condenser.ts`), auto-test generator (`lib/harness/auto-test.ts`), and locator + dependency radar (`lib/harness/locator-mcp-source.ts`).
- From `omnexx/`: System One gates/hooks (`lib/harness/system-one/`), provider catalog additions (`lib/providers/catalog-more.ts`), web search + SSRF guard (`lib/web/`), run diagnosis + efficiency (`lib/telemetry/`), Stage 0/3 verification (`lib/verification/{ast-analysis,diff-hygiene,revert-proof}.ts`), test digest (`lib/harness/test-digest.ts`), redundant-read / verification coalescer (`lib/harness/redundant-read.ts`), structured parsers (`lib/verification/parsers.ts`), gate ratchet / flaky quarantine / multi-language anti-cheat (`lib/verification/ratchet.ts`), 3-way differential TDR (`lib/verification/differential-tdr.ts`), and declarative browser gate (`lib/verification/browser-gate.ts`).
- Retired without porting: `agl/` and `tools/agl/` (zero in-app integration; custom S-expression substrate offered negative token ROI over native TS/MCP tools and `tool-forge-mcp.ts`).
