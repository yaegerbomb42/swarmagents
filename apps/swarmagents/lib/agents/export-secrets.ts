/**
 * Value-level secret detection for the agent export route.
 *
 * The export route strips secret-shaped *keys* structurally and re-scans the
 * result for credential-shaped *values* (a token pasted into a system prompt,
 * for example). Scanning parsed strings — not the serialized JSON — means a
 * quoted `"token": "..."` example inside a prompt is not mistaken for an object
 * key.
 */

/**
 * Credential-shaped *values* (not keys): provider tokens, GitHub PATs, cloud
 * access keys, Slack tokens, JWTs, Google/Groq/Hugging Face/Perplexity keys,
 * PEM private-key blocks and Bearer tokens. Secret-shaped keys are handled
 * structurally by `containsSecretKeys`; this catches a secret pasted into free
 * text such as a system prompt.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Groq.
  /\bgsk_[A-Za-z0-9]{20,}\b/,
  // Hugging Face.
  /\bhf_[A-Za-z0-9]{20,}\b/,
  // Perplexity.
  /\bpplx-[A-Za-z0-9]{20,}\b/,
  // PEM private key blocks (leading \b is intentionally omitted: the block
  // opens with a non-word `-`, so a word boundary would never match).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Bearer tokens: an opaque bearer token of at least 20 token characters.
  /\bBearer\s+[A-Za-z0-9._~+\/=]{20,}/,
];

/**
 * True when any string value in the tree matches a credential-shaped pattern.
 *
 * Fails closed: a tree nested deeper than the recursion limit is treated as
 * containing a secret so a deeply nested manifest field cannot bypass the scan.
 */
export function containsSecretValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof value === "string") return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some((entry) => containsSecretValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => containsSecretValue(entry, depth + 1));
  }
  return false;
}
