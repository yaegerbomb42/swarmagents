# vendor/: reference snapshots (pending step 2)

Three earlier projects were brought into SwarmAgents as plain source snapshots so the useful parts can be ported
into the app by pull request. Nothing in the app imports from here, and this folder is excluded from the app's
typecheck, lint, tests and Docker build context.

| Folder | What it is | Snapshot |
| --- | --- | --- |
| `omnexx/` | Omnexx: autonomous coding agent CLI + VS Code extension (TypeScript, 1.0.0) | from the former standalone repo, `main@fac3784` |
| `agl/` | AGL: S-expression agent language, runtime and primitive ledger (`agl-lang` 1.0.0) | archived git history |
| `swarmagents-repo/` | Leftovers from the old standalone `swarmagents` repo not found elsewhere here (role registry, key clusters, racing engine, UI ideas, engine patch); see its README | `yaegerbomb42/swarmagents` `main@d4712b6` |
| `claude-code-mini/` | Claude Code Mini 0.3.0: stateless 8k-token coding agent (provider key pooling) | archived PR #215 |

Plan: for each useful piece, open a PR that ports it into `apps/swarmagents/lib/...` (with tests), and delete the
vendored folder once nothing is left worth keeping. Already ported: the context governor and AST slicer
(`lib/harness/context`), the System One gates/hooks (`lib/harness/system-one`) and the provider catalog additions
(`lib/providers/catalog-more.ts`).
