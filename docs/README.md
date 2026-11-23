# Documentation index

New here? Start with the guides. Operating or contributing? The
reference sections follow.

## Guides

| Guide | Contents |
| --- | --- |
| [getting-started.md](getting-started.md) | Zero to first run: create an account, add your own provider key (BYOK), describe a task, watch/approve/take over, collect the result |
| [concepts.md](concepts.md) | Runs, VMs, providers/BYOK, BYOC, takeover, approval gate, trajectories/replay, memory, roles, projects, and the board |
| [self-hosting.md](self-hosting.md) | Run your own deployment: prerequisites, local dev, Docker/Compose, server-mode variables, sign-up posture, email, BYOC, production deploys and rollback |
| [api/README.md](api/README.md) | API reference skeleton: auth model, route groups under `app/api/` (runtime, providers, byoc/computers, team, mcp, …), conventions |

## Reference

| Folder | Contents |
| --- | --- |
| [architecture/](architecture/) | [master-plan.md](architecture/master-plan.md) (build plan), [why.md](architecture/why.md) (principles), [board-agent.md](architecture/board-agent.md), [secret-vault.md](architecture/secret-vault.md), screenshots. System architecture: [apps/swarmagents/README.md](../apps/swarmagents/README.md) |
| [deploy/](deploy/) | How production is deployed, secrets, rollback. Full operator reference: [apps/swarmagents/DEPLOY.md](../apps/swarmagents/DEPLOY.md) |
| [playtest/](playtest/) | Running SwarmAgents and signing in as the shared test account |
| [archive/](archive/) | Historical material: earlier repo notes and the dashboard design mock |

Other docs live next to the code they describe: `apps/swarmagents/deploy/README.md` (VPS scripts),
`apps/swarmagents/vm-image/README.md`, `apps/swarmagents/packages/swarm-node/README.md`, `apps/swarmagents/e2e/README.md`,
`apps/swarmagents/vendor/README.md` (staged scraps).
