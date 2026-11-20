# shell-classifier

AST-based risk classifier for shell commands, written by Hydrogen (Gemini) and
ported from its standalone `shell-command-gate` package. Pure code: no I/O, no
env, no clock. Runtime dependency: `zod` (works with zod 3 and 4).

`classifyCommand({ command, cwd, role, workspaceRoot?, homeDir?, allowlistedHosts? })`
returns `{ risk: "safe" | "review" | "block", reasons, categories, normalized,
touchesPaths, networkTargets }`.

It is wired into `lib/harness/risk.ts` (`classifyCommandAst`), which combines it
with the older regex rules; the stricter verdict wins. See that file for the
mapping from safe/review/block to allow/ask/deny.

Changes from Hydrogen's original:
- `.js` import suffixes dropped to match the app's module style.
- Type fixes so it compiles under `strict`: a `peekOp()` helper in the parser
  (TS can't narrow repeated `peek()?.op` calls), explicit `kind !== "simple"`
  guards, and removal of a non-existent `WordToken.startsWithDash` field.
- Bug: bracketed IPv6 hosts (`http://[::1]:5173`) were parsed as `[`, and
  `::1` lost its last group to the `:port` stripper. Both fixed.
- Bug: `bash <(curl ...)` (process substitution into a shell) was only
  "review". It is now treated like `curl ... | sh` and blocked.
- Uploading a secret file (`curl -d @.env https://...`) now reports
  `network_exfil` alongside `secrets`.
- The `git push` review reason printed a literal `.trim()`.
