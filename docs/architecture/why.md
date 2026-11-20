# WHY.md: principles

SwarmAgents is the only project in this repository. These are the lessons it is built on.

- **You cannot one-shot huge apps.** Complex systems that work evolved from simple systems that worked.
  Ship a small thing that works, then grow it.
- **You cannot build in a desert and assume an oasis of people will flock.** Distribution, direct human
  utility and fast feedback loops matter more than scaffolding.
- **The harness should never work the builder.** Avoid autonomous bureaucracy (circuit breakers, lock
  managers, speculative agent scaffolding). The model is a high-leverage amplifier inside a simple, direct loop.
- **Quality over volume.** One merged, tested change beats ten open branches.
- **Short-lived branches.** Branch from `main`, open a PR, merge as soon as it is green, delete the branch.
  Every worker starts from the same `main`.
- **Everything is reachable through GitHub.** Any agent can clone, build, test and ship through pull
  requests and the Actions workflows. No hidden machine state.
- **Secrets never live in the repo.** Keys and passwords are repo secrets or server env, never files in git.

## What is deployed

- `https://swarmagents.codes` on an Oracle VPS: the container `swarmagents-dashboard` (image
  `swarmagents-v2:latest`) behind nginx with TLS, with per-user VM containers for the agent runtime.
- Deploys are built on the VPS from `origin/main` by the forced-command deploy script; see
  [docs/deploy](../deploy/README.md).

## Where code is going

`apps/swarmagents/vendor/{omnexx,agl,claude-code-mini}` are reference snapshots of three earlier projects.
The plan is to port the useful parts into the app by PR and delete each vendored folder once it is mined.
