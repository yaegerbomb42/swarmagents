# Security policy

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public issue or pull request.

- Use GitHub's **Report a vulnerability** (Security tab > Advisories) on <https://github.com/yaegerbomb42/swarmagents>, or
- contact the maintainer, [@yaegerbomb42](https://github.com/yaegerbomb42), directly on GitHub.

Include what you found, steps to reproduce, and the impact. We aim to acknowledge reports within a few days.

## Scope

The SwarmAgents app (`apps/swarmagents`) and the live service at <https://swarmagents.codes>: authentication and sessions,
per-user provider key storage, the per-user VM runtime and its egress rules, the swarm board and its MCP endpoint, and the deploy tooling.

## Handling secrets

- No secret belongs in this repository. Provider keys are encrypted per user server-side; deploy and playtest credentials live only in GitHub secrets.
- If you find a credential in the repo or its history, report it privately as above so it can be rotated.
- `scripts/` and the Playtest workflow never print keys, passwords or cookies; keep it that way in changes.

## Supported versions

Only the current `main` and what is deployed to production.
