# F11 zero-leak secret vault

## Threat model

The VM is hostile. Agent code, shell history, `/workspace/.env`, and process
environment can be read by the model or by anything it runs. A real GitHub,
Stripe, Vercel, AWS, or database credential that enters that boundary is
treated as leaked.

The host process is the trust boundary. It holds AES-256-GCM sealed secrets
(same box as provider keys) and is the only place that opens them.

## What the VM sees vs what the proxy sees

The VM receives:

- `SWARM_VAULT_PROXY_URL` — host route `/api/runtime/vault/<token>/proxy`
- `SWARM_VAULT_TOKEN` — HMAC token scoped to one user, one run, and the secret ids minted for that run
- per-kind placeholders (`GITHUB_TOKEN`, `STRIPE_SECRET_KEY`, `VERCEL_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`) set to that same ephemeral token or to `vault://<id>`

Those placeholders are not the stored credentials. A tool that sends
`GITHUB_TOKEN` straight to `api.github.com` presents a useless token.

The proxy sees the destination URL, method, and body the VM sent. After the
token is verified, the run is unrevoked, and the hostname is on that kind's
allowlist, the host opens the sealed secret and adds it to the upstream
request only:

- GitHub, Stripe, Vercel: `Authorization: Bearer <stored token>`
- AWS: SigV4 `Authorization` built from the sealed access key id and secret
- Database: never. HTTP injection cannot speak Postgres/MySQL, so the proxy
  refuses and the raw URL is never copied into the VM.

Redirects are not followed. An allowlisted host that 302s elsewhere would
otherwise carry the injected credential. IP literals and userinfo in the URL
are rejected. The VM's own `Authorization` and `Cookie` headers are dropped
before the request is forwarded.

## Revocation

The token embeds `expiresAt` (same TTL knob as run tokens,
`SWARM_RUN_TOKEN_TTL_SEC`). `finalize` calls `revokeVaultToken(runId)`, so a
finished, failed, or cancelled run cannot keep calling the proxy. A stolen
token works only until that revoke or expiry, only for the secret ids inside
it, and only for allowlisted hosts.

## If the proxy is bypassed

Bypass means the VM opens its own TCP connection and does not use the proxy.
It does not have the real credential, so the bypass cannot authenticate as
the user. The residual risk is the inverse: a stolen ephemeral token used
against the host proxy from outside the VM. That still cannot extract the
secret (the proxy never returns it and audit lines store kind, id, and host
only) but it can perform allowlisted calls until revoke. Egress policy that
forces the VM through the host is defense in depth, not the mechanism that
hides the secret.

## Hole that is not papered over

Database URLs are stored sealed and are not injected. There is no TCP
database gateway in this change. Putting `DATABASE_URL` in the VM would be
the leak this design exists to prevent.
