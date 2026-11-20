# AGENTS.md: working on SwarmAgents

## Deploy (only when the owner says so)

Production is built on the VPS from `main`. Merge first, then deploy.

1. Actions > **Deploy** > Run workflow > `deploy` (manual, `main` only; typecheck and unit tests run first).
   Other actions: `status`, `rollback`, `logs`, `cleanup`.
2. Or from a shell: `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<key path>` then `./deploy.sh deploy|status|rollback|logs`.
3. Secrets (never in the repo): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. See `docs/deploy/README.md`.
4. Gates (from `apps/swarmagents`): `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run lint`, `npm run build`.
5. Rollback: Deploy workflow with `rollback`. Status: same workflow with `status`.

## Playtest

Shared test account with provider keys loaded. In `apps/swarmagents`:

```bash
export SWARM_BASE_URL=https://swarmagents.codes SWARM_TEST_EMAIL=... SWARM_TEST_PASSWORD=...   # from the secret store
npm run playtest:check      # signs in, lists connected providers (counts only)
npm run playtest:login      # also writes a cookie header to ./.swarm-playtest-cookies (gitignored)
npm run playtest:seed       # loads provider keys from TEST_PROVIDERS_MANIFEST + TEST_<PROVIDER>_API_KEY
```

Or Actions > **Playtest login check**. Details: `docs/playtest/README.md`.

## Rules

- **All PRs go to `github.com/yaegerbomb42/swarmagents`** (this repo, the single source of truth). The earlier private repo is a frozen archive: never open PRs or push there.
- The only app is `apps/swarmagents/` and that path must not move (the VPS deploy script reads it).
  `apps/swarmagents/vendor/` is read-only reference material being extracted into the app and then deleted.
- Branch from `main`, keep branches short-lived, open a PR, wait for CI, squash-merge, delete the branch.
  Never force-push `main`; never rewrite history.
- Claim work on the swarm board first (`apps/swarmagents/tools/swarm-board/README.md`); leave review notes as PR comments.
- Never commit or print secrets (keys, passwords, tokens, cookies, server addresses). Use env vars and repo secrets.
- Binary assets (png, gif, mp4, jpg, ...) are Git LFS: install `git-lfs` before committing binaries.
- Known test baseline: a handful of tests fail on `main` (ambient and computers store-mutex, client swarm-catalog, swarm-node
  host-mode). Do not add to the list. Some browser and budget-gate tests can show as cancelled on resource-limited machines.

## Where things are

`docs/README.md` indexes everything. App architecture: `apps/swarmagents/README.md`. Plan: `docs/architecture/master-plan.md`.
