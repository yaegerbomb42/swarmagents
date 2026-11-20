/**
 * Destination hosts a vault secret may be attached to.
 * Match is exact or a single subdomain label under the suffix — never a
 * substring — so `api.github.com.evil.test` is not `api.github.com`.
 */

export const SECRET_KINDS = ["github", "stripe", "vercel", "aws", "database"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export function isSecretKind(value: unknown): value is SecretKind {
  return typeof value === "string" && (SECRET_KINDS as readonly string[]).includes(value);
}

/** HTTP kinds inject a credential. Database is stored only. */
export const HTTP_KINDS: readonly SecretKind[] = ["github", "stripe", "vercel", "aws"];

const ALLOWED: Record<SecretKind, readonly string[]> = {
  github: ["api.github.com"],
  stripe: ["api.stripe.com"],
  vercel: ["api.vercel.com"],
  aws: ["amazonaws.com"],
  database: [],
};

export function allowedSuffixes(kind: SecretKind): readonly string[] {
  return ALLOWED[kind];
}

export function hostAllowed(kind: SecretKind, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("..")) return false;
  for (const suffix of ALLOWED[kind]) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}
