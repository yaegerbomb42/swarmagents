/**
 * Env handed to a VM. Values are the ephemeral token or a vault:// pointer.
 * Stored credentials are not arguments to this function and cannot appear here.
 */

import { listSecrets, type SecretView } from "./registry";
import { signVaultToken } from "./token";

const PLACEHOLDER: Record<SecretView["kind"], string> = {
  github: "GITHUB_TOKEN",
  stripe: "STRIPE_SECRET_KEY",
  vercel: "VERCEL_TOKEN",
  aws: "AWS_SECRET_ACCESS_KEY",
  database: "DATABASE_URL",
};

export function vaultProxyEnv(
  userId: string,
  runId: string,
  baseUrl: string | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!baseUrl) return {};
  const secrets = listSecrets(userId, env);
  if (secrets.length === 0) return {};
  const token = signVaultToken(
    userId,
    runId,
    secrets.map((s) => s.id),
    { env },
  );
  const origin = baseUrl.replace(/\/+$/, "");
  const out: Record<string, string> = {
    SWARM_VAULT_TOKEN: token,
    SWARM_VAULT_PROXY_URL: `${origin}/api/runtime/vault/${token}/proxy`,
  };
  for (const secret of secrets) {
    const name = PLACEHOLDER[secret.kind];
    out[name] = secret.kind === "database" ? `vault://${secret.id}` : token;
    if (secret.kind === "aws") out.AWS_ACCESS_KEY_ID = "vault";
    if (secret.kind === "github") out.GH_TOKEN = token;
  }
  return out;
}

/** File body that would be written to /workspace/.env. Same map, nothing else. */
export function renderWorkspaceEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v.replace(/\n/g, "")}`)
    .join("\n");
}
