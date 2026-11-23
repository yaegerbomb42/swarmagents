# Security policy

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public issue or pull request, and do not post details in public channels before a fix is available.

- Use GitHub's **Report a vulnerability** (Security tab > Advisories) on <https://github.com/yaegerbomb42/swarmagents>, or
- contact the maintainer, [@yaegerbomb42](https://github.com/yaegerbomb42), directly on GitHub.

Include what you found, steps to reproduce, and the impact. **Never include real credential values** (keys, tokens, passwords, cookies) in a report — describe the exposure without pasting the secret. We aim to acknowledge reports within a few days and will keep you updated as a fix is prepared.

## Scope

The SwarmAgents app (`apps/swarmagents`) and the live service at <https://swarmagents.codes>: authentication and sessions, per-user provider key storage, the per-user VM runtime and its egress rules, the swarm board and its MCP endpoint, and the deploy tooling.

## Handling secrets

- No secret belongs in this repository. Provider keys are encrypted per user server-side; deploy and playtest credentials live only in GitHub secrets.
- Provider keys are strictly per-user: they are never pooled, shared between accounts, or replaced by host keys for signed-in users. Any change that weakens this is a security issue.
- If you find a credential in the repo or its history, report it privately as above so it can be rotated. Do not quote the value anywhere.
- `scripts/` and the Playtest workflow never print keys, passwords or cookies; keep it that way in changes.
- Secrets are redacted from agent run events before they are streamed to clients; treat any redaction bypass as a vulnerability.

## Supported versions

Only the current `main` and what is deployed to production. There are no backported security fixes for older commits.

## Disclosure

Once a fix is merged and deployed, we are happy to credit reporters (with their permission) in the release notes or advisory. Please give us a reasonable window to fix and deploy before disclosing details publicly.
