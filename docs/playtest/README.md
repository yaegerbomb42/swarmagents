# Playtesting SwarmAgents

How any agent (or the owner) runs SwarmAgents and signs in as the **shared test account**, which has the provider
API keys loaded so real runs work. No credentials live in this repo. The account, its password and the keys are
supplied through environment variables or GitHub secrets.

## 1. Run it

Local (fake VM driver, no Docker needed, signup open on loopback):

```bash
cd apps/swarmagents
npm ci
npm run dev                 # http://127.0.0.1:3777
```

Local in server mode (closer to production):

```bash
export SWARM_SERVER_MODE=1 SWARM_ALLOW_SIGNUP=1 SWARM_VM_DRIVER=fake
export SWARM_SESSION_SECRET="$(openssl rand -hex 32)" SWARM_ALLOWED_HOSTS=127.0.0.1,localhost
npm run build && npm start
```

Production (`https://swarmagents.codes`) is the shared target for playtests of merged code.

## 2. Sign in as the test account

```bash
export SWARM_BASE_URL=http://127.0.0.1:3777     # default is https://swarmagents.codes
export SWARM_TEST_EMAIL=...                      # from the shared secret store / repo secret
export SWARM_TEST_PASSWORD=...
npm run playtest:login      # signs in, writes a session cookie header to ./.swarm-playtest-cookies (gitignored)
npm run playtest:check      # lists which providers have keys (counts only, never key values)
```

Use the cookie in `curl -H "cookie: $(cat .swarm-playtest-cookies)" ...`, or paste its value into a Playwright
`context.addCookies` call. In a browser, just sign in at `/login` with the same email and password.
`scripts/playtest.mjs` never prints passwords, keys or cookies.

## 3. Load the provider keys into the test account

Provider keys are stored per user and encrypted server-side, so they are loaded into the **test account** (not
the host environment). `seed` does it through the public API, idempotently (a provider that already has its key
is skipped).

The keys come from GitHub Actions secrets named `TEST_<PROVIDER>_API_KEY`, described by a non-secret repo
variable **`TEST_PROVIDERS_MANIFEST`**: a JSON array of

```json
{"provider": "groq", "secretName": "TEST_GROQ_API_KEY", "baseUrl": "https://...", "baseUrlName": "TEST_X_BASE_URL",
 "apiStyle": "openai-chat", "bestModel": "model-id"}
```

`provider` is a provider id from `lib/providers/catalog*.ts`; `baseUrl`, `baseUrlName` (a variable/secret holding the
URL), `apiStyle` and `bestModel` are optional and are passed to `POST /api/providers` (`bestModel` becomes the
provider's model list). Locally, export the same names as environment variables (or point
`SWARM_MANIFEST_FILE` at a manifest file) and run:

```bash
export TEST_GROQ_API_KEY=...            # one per manifest entry's secretName
export TEST_PROVIDERS_MANIFEST="$(cat manifest.json)"
npm run playtest:seed
```

`SWARM_PROVIDER_KEYS_JSON='{"groq":["k1","k2"]}'` still works for ad-hoc multi-key loads. If the account does not
exist yet and the server has `SWARM_ALLOW_SIGNUP=1`, add `SWARM_TEST_SIGNUP=1` to create it on first login.

## 4. From GitHub Actions

`.github/workflows/playtest.yml` (manual) signs in as the test account and prints the connected providers. Tick
`seed` to load the manifest's keys first. It reads from the dedicated `playtest` GitHub Environment
(Settings > Environments > playtest), not the `production` environment:

| Secret / variable | What |
| --- | --- |
| `SWARM_TEST_EMAIL` (secret) | test account email |
| `SWARM_TEST_PASSWORD` (secret) | test account password |
| `TEST_<PROVIDER>_API_KEY` (secrets) | one per provider, named in the manifest |
| `TEST_PROVIDERS_MANIFEST` (variable) | the JSON array above |
| `SWARM_BASE_URL` (variable, optional) | target server, default `https://swarmagents.codes` |

The `playtest` environment must contain only test-account credentials and test provider keys. Keep `DEPLOY_SSH_KEY`,
`DEPLOY_HOST`, `SWARM_HARNESS_TOKEN` and other production secrets in the `production` environment: the playtest job
never receives them, so a compromised playtest step cannot read the deploy key or server address.

## What the owner must provide

1. Create the test account (sign up at `/login` with `SWARM_ALLOW_SIGNUP=1` on the server, or run
   `playtest:login` with `SWARM_TEST_SIGNUP=1` where signup is enabled) and choose its password.
2. Create a `playtest` GitHub Environment and set `SWARM_TEST_EMAIL`, `SWARM_TEST_PASSWORD`, the `TEST_<PROVIDER>_API_KEY` secrets and the `TEST_PROVIDERS_MANIFEST` variable there (the key-loading job is doing the last two). Do not put production secrets in this environment.
3. Share the email and password with agents only through the secret store, never in chat, PRs or files in the repo.
4. Rotate any key that was ever pasted into chat, a tracked file or an npm package.
