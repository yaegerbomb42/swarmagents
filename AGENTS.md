# AGENTS.md: working on SwarmAgents

## Deploy (only when the owner says so)

Production is built on the VPS from `main`. Merge first, then deploy.

1. Actions > **Deploy** > Run workflow > `deploy` (manual, `main` only; typecheck and unit tests run first).
   Other actions: `status`, `rollback`, `logs`, `cleanup`.
2. Or from a shell: `export DEPLOY_HOST=<host> DEPLOY_SSH_KEY=<key path>` then `./deploy.sh deploy|status|rollback|logs`.
3. Secrets (never in the repo): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. See `docs/deploy/README.md`.
4. Gates (from `apps/swarmagents`): `npm ci`, `npm run typecheck`, `npm run test:full`, `npm run lint`, `npm run build`.
5. Rollback: Deploy workflow with `rollback`. Status: same workflow with `status`.

## Testing

Run from `apps/swarmagents`. Tests use Node's built-in runner (`tsx --test`).

```bash
npm run test:fast     # unit tier: lib + components + minimalist-ui + swarm-node (~30s)
npm run test:full     # everything including API-route tests — the merge gate
npm run test:affected # run ONLY tests affected by your change (impact-based)
npm run test:coverage # full suite with a coverage summary (lines/branches/funcs)
```

- **Prefer `test:affected` while iterating** — it runs only tests that touch your
  changed files (the changed test itself, sibling tests, and tests that import a
  changed module). Run the full suite before opening a PR.
  `npx tsx scripts/test-affected.ts` (vs HEAD), `--rev origin/main`, or pass files:
  `npx tsx scripts/test-affected.ts lib/foo.ts lib/bar.ts`.
- `test:full` runs at `--test-concurrency=4` (~40s, was ~2.5min serial).
- CI emits a JUnit XML artifact (`junit.xml`) for every run.

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
- Binary assets (png, gif, mp4, jpg, ...) are Git LFS: install `git-lfs` before committing binaries. Exception: small web/brand assets under `apps/swarmagents/public/`, `app/` and `apps/swarmagents/branding/` are normal git files because the server never runs LFS (see docs/deploy/README.md).
- Known test baseline: a handful of tests fail on `main` (ambient and computers store-mutex, client swarm-catalog, swarm-node
  host-mode). Do not add to the list. Some browser and budget-gate tests can show as cancelled on resource-limited machines.

## Where things are

`docs/README.md` indexes everything. App architecture: `apps/swarmagents/README.md`. Plan: `docs/architecture/master-plan.md`.
