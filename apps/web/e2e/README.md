# E2E (Playwright)

Covers the real user path end to end: landing → auth → decompose → inner-world → billing.
Chromium only. **No real Azure / Stripe / Firebase keys required.**

## Run

```bash
cd dashboard
npm run test:e2e:install   # one-time: downloads chromium
npm run test:e2e           # starts `next dev` on :3100 and runs the suite
```

`playwright.config.ts` manages the web server automatically (`next dev`, port 3100).
For a production-parity run against a build:

```bash
npm run build && E2E_USE_BUILD=1 npm run test:e2e
```

Or point at an already-running server (dev, staging, prod-preview):

```bash
BASE_URL=https://staging.swarmagents.codes npx playwright test
```

## Mocking model

Each spec self-mocks at the **browser network boundary** via `page.route` —
nothing reaches a real external service:

| Surface | Mock | Fixture |
|---|---|---|
| Firebase Auth REST (`identitytoolkit.googleapis.com`, `securetoken.googleapis.com`) | route-mocked; dummy `NEXT_PUBLIC_FIREBASE_*` injected by config so `lib/firebase.ts` initializes | `fixtures/mockFirebase.ts` |
| Engine API (`/api/engine/api/decomposition/*`, `/auth/provision`, `/api/auth/me`, `/api/billing/debit`) | route-mocked at the Next rewrite boundary | `fixtures/mockEngine.ts` |
| Dashboard billing proxy (`/api/billing/balance`) | route-mocked | `fixtures/mockEngine.ts` |
| Synth event generator (`/api/events/synth`) | **real SSE endpoint** — no mock needed, needs no LLM keys | — |

The inner-world spec exercises the real dev synth generator EventSource
contract end-to-end. The full grid render through `agentStreamStore` is
blocked by an upstream bug (uncached `agentsSnapshot()` →
`useSyncExternalStore` loops under React 18 dev render); see the comment in
`inner-world.spec.ts`.

## Env overrides

| Var | Effect |
|---|---|
| `BASE_URL` | Skip managed server; test an existing deployment. |
| `E2E_USE_BUILD=1` | Managed server uses `next start` instead of `next dev` (requires prior `next build`). |
| `E2E_PORT` | Managed server port (default 3100). |
| `CI=1` | Retries once, serial workers, GitHub reporter. |

## Specs

- `landing.spec.ts` — hero/brand render; header nav → /login, /signup.
- `auth.spec.ts` — login renders; mocked email/password sign-in succeeds, caches `auth_token`, redirects to `next`; Firebase error mapping renders inline error.
- `decompose.spec.ts` — goal submit → mocked createProject+tree → NeonTree SVG renders nodes; engine 500 renders error panel.
- `inner-world.spec.ts` — real synth SSE stream yields well-formed agent events; page chrome mounts.
- `billing.spec.ts` — pricing packs + model table; mocked balance=0 + engine debit 402 `insufficient_credits` contract; /billing renders without Stripe keys.
