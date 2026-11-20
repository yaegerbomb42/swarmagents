# Contributing to SwarmAgents

Humans and agents follow the same flow.

1. **Branch** from `main`: `feat/...`, `fix/...`, `docs/...`, `chore/...`. Keep it small and short-lived.
2. **Work in `apps/swarmagents/`.** Do not edit `vendor/` except to delete a folder after its useful parts were extracted.
3. **Run the gates** from `apps/swarmagents`:
   ```bash
   npm ci
   npm run typecheck
   npm run test:unit
   npm run lint
   npm run build
   ```
   `main` has a few known failing tests (see AGENTS.md). Your PR must not add failures. Add tests for new behavior.
4. **Open a PR** using the template. Describe what changed and how you verified it. CI must pass.
5. **Merge:** squash-merge, delete the branch. Never force-push `main`.
6. **Binaries** (png, gif, mp4, jpg, ...) go through Git LFS; install `git-lfs` first.
7. **No secrets, ever:** no keys, tokens, passwords, cookies, server addresses or real `.env` files in commits, PRs, issues or logs.

Commit messages: `type(scope): summary` (for example `feat(router): add hedged requests`).

Deploying is a separate, manual step done by the owner or on the owner's say-so; see `docs/deploy/README.md`.

Security issues: do not open a public issue; see [SECURITY.md](SECURITY.md).
