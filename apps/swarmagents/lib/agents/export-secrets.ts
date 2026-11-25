/**
 * Value-level secret detection for the agent export route.
 *
 * The export route strips secret-shaped *keys* structurally and re-scans the
 * result for credential-shaped *values* (a token pasted into a system prompt,
 * for example). Scanning parsed strings — not the serialized JSON — means a
 * quoted `"token": "..."` example inside a prompt is not mistaken for an object
 * key.
 */

import { SECRET_PATTERNS } from "../harness/redact";

/**
 * Credential-shaped *values* (not keys): provider tokens, GitHub PATs, cloud
 * access keys, Slack tokens, JWTs, Google/Groq/Hugging Face/Perplexity keys,
 * PEM private-key blocks and Bearer tokens. Secret-shaped keys are handled
 * structurally by `containsSecretKeys`; this catches a secret pasted into free
 * text such as a system prompt.
 *
 * The pattern set is derived from the harness's canonical `SECRET_PATTERNS`
 * (single source of truth) so secret-pattern fixes apply in one place and the
 * value scanner cannot drift from the redactor. `SECRET_PATTERNS` carry the
 * `g` flag for replacement, which would make `.test()` stateful, so each is
 * re-cloned without it for stateless matching.
 */
function valuePatterns(): readonly RegExp[] {
  return [
    ...SECRET_PATTERNS.map(({ pattern }) => {
      const flags = pattern.flags.replace("g", "");
      return flags.length > 0 ? new RegExp(pattern.source, flags) : new RegExp(pattern.source);
    }),
    // Superset preservation: the export scanner historically flagged `sk-`
    // tokens from 16 chars (the redactor only masks at 20+). Keep the broader
    // threshold so no currently-caught shape is lost in the import.
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
  ];
}

const SECRET_VALUE_PATTERNS: readonly RegExp[] = valuePatterns();

/**
 * True when any string value in the tree matches a credential-shaped pattern.
 *
 * Fails closed: a tree nested deeper than the recursion limit is treated as
 * containing a secret so a deeply nested manifest field cannot bypass the
 * scan, and a circular reference is treated the same way instead of
 * recursing forever or silently skipping the unscanned remainder.
 */
export function containsSecretValue(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 20) return true;
  if (typeof value === "string") return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((entry) => containsSecretValue(entry, depth + 1, seen));
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsSecretValue(entry, depth + 1, seen),
    );
  } finally {
    seen.delete(value);
  }
}
