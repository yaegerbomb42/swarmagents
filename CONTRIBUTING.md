# Contributing to SwarmAgents

Thanks for helping build SwarmAgents. All changes go through pull requests to <https://github.com/yaegerbomb42/swarmagents>. The earlier private repo is a frozen archive — never open PRs or push there.

Humans and agents follow the same flow. Agents: also read [AGENTS.md](AGENTS.md) before touching anything.

## Before you start

- **Check for existing work.** Search open PRs and issues first — SwarmAgents moves fast and duplicate PRs waste everyone's time.
- **One change per PR.** Small, focused, reviewable. If a change needs a second unrelated change, split it.
- **Security issues are not issues.** Report them privately per [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node.js 22 and npm. Docker is optional for app development (the fake VM driver is the default outside production) and required only to build or run the real VM images. Binary assets (png, gif, mp4, jpg, ...) are tracked with Git LFS — install `git-lfs` before your first commit that touches them.

```bash
git clone https://github.com/yaegerbomb42/swarmagents.git
cd swarmagents/apps/swarmagents
npm ci
npm run dev        # http://127.0.0.1:3777
```

The app lives in `apps/swarmagents/`. That exact path is what the production deploy syncs and builds — do not move it.

## Making a change

1. **Branch** from `main`: `feat/...`, `fix/...`, `docs/...`, `chore/...`. Keep branches small and short-lived.
2. **Work in `apps/swarmagents/`.** Do not edit `vendor/` — it is staged material waiting to be mined. The only allowed `vendor/` change is deleting a folder after its useful parts were extracted in an earlier PR.
3. **Add tests for new behavior.** Unit tests live next to the code (`*.test.ts`) and run with `npm run test:unit`. A PR that deletes tests to make CI pass will not be merged.
4. **Run the gates** from `apps/swarmagents` before pushing:

   ```bash
   npm run typecheck
   npm run test:unit
   npm run lint
   npm run build
   ```

   `main` occasionally carries known failing tests (see AGENTS.md). Your PR must not add new failures.

5. **Commit messages:** `type(scope): summary` — for example `feat(router): add hedged requests`, `fix(vm): stop idle sweeper racing exec`.

## Pull requests

- Open the PR against `main` and fill in the template: what changed, why, and how you verified it.
- CI must pass: **Repo consistency** and **SwarmAgents gates** (typecheck, unit tests, lint, build), plus the SonarCloud quality gate. A SonarCloud failure caused only by code duplication is non-blocking; security and reliability findings are blocking.
- Reviewers check for: scope creep, deleted or weakened tests, hardcoded secrets, server-wide provider/key storage (keys are per-user, always — see below), and unrequested deploy or Docker changes.
- Merges are squash-merges; the branch is deleted after merge. Never force-push `main`.

## Hard rules

- **No secrets, ever.** No keys, tokens, passwords, cookies, server addresses, or real `.env` files in commits, PRs, issues, or logs. If you find a credential in the repo or its history, report it privately per [SECURITY.md](SECURITY.md) so it can be rotated.
- **Per-user BYOK only.** Provider keys belong to individual users, are encrypted at rest, and are never pooled or shared between accounts. Do not add server-wide key storage or make signed-in accounts run on host keys.
- **No deploy changes without discussion.** Deploy workflows, Dockerfiles, and VPS scripts change only with the owner's explicit approval. Deploying itself is a separate, manual step — see [docs/deploy/README.md](docs/deploy/README.md).
- **Keep the app booting.** Every PR must leave `main` buildable and runnable.

## Conduct

Be direct, be kind, assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions

Open an issue with the feature-request template, or check [docs/README.md](docs/README.md) for the documentation index.
