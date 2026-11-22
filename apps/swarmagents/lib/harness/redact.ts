/**
 * Sensitive-string scrubbing for anything that carries telemetry out of the
 * harness. Provider keys are passed to the child via env only, but values can
 * still leak into assistant text, tool outputs, or error strings (e.g. a tool
 * echoing an env var). The redactor used here guarantees emitted event text
 * never contains a known secret, and additionally masks common key shapes
 * (sk-..., sk-ant-..., ghp_..., AKIA..., xoxb-..., Bearer tokens) even when
 * the value was never visible in env.
 */

const SENSITIVE_ENV_KEY = /(key|token|secret|password|auth|bearer)/i;
const LOOKS_LIKE_KEY = /^(sk-|ghp_|gho_|xox[bp]-)/;

// Key shapes that must be masked wherever they appear in text, even when
// the env var that carried them was never visible to us (e.g. a tool in the
// VM printing a key out of its own environment). Every pattern requires a
// distinctive prefix, so bare hex strings such as git SHAs are left alone.
export const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic API keys: sk-ant-api03-...
  { pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED]" },
  // OpenAI-style keys: sk-... / sk-proj-...
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED]" },
  // GitHub tokens: ghp_... (classic PAT) and the other gh*_ prefixes.
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  // GitHub fine-grained PATs: github_pat_...
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED]" },
  // AWS access key IDs: AKIA + 16 uppercase alphanumerics.
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED]" },
  // Slack tokens: xoxb-... (bot), xoxp-... (user), xoxa-/xoxr-/xoxs-...
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED]" },
  // Google/Gemini API keys: AIza + 35 base64url chars.
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: "[REDACTED]" },
  // PEM private key blocks: mask the entire block, header and base64 body,
  // not just the header line (the body alone is the secret material).
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED]" },
  // Truncated / unterminated PEM bodies: a header with no END marker still
  // carries raw base64 key material; mask the header with the body run after
  // it (bounded so a stray header cannot swallow an arbitrary amount of log).
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{1,4096}/g, replacement: "[REDACTED]" },
  // Bare PEM headers (no body follows) still mark the material as a key.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED]" },
  // Authorization headers: keep the scheme, mask the credential.
  { pattern: /Bearer [A-Za-z0-9._~+\-/=]{10,}/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic [A-Za-z0-9+/]{10,}={0,2}/gi, replacement: "Basic [REDACTED]" },
  // JWTs: three dot-separated base64url segments, the payload starts eyJ.
  { pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replacement: "[REDACTED]" },
  // Groq: gsk_...
  { pattern: /gsk_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  // Hugging Face: hf_...
  { pattern: /hf_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  // Perplexity: pplx-...
  { pattern: /pplx-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  // URL-embedded credentials: keep the scheme, mask user:password@.
  { pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, replacement: "$1[REDACTED]@" },
];

export function makeRedactor(
  env?: Record<string, string>,
  extraSecrets?: Iterable<string>,
): (text: string) => string {
  const secrets = new Set<string>();
  if (env) {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value !== "string" || value.length < 6) continue;
      if (SENSITIVE_ENV_KEY.test(name) || LOOKS_LIKE_KEY.test(value)) {
        secrets.add(value);
      }
    }
  }
  if (extraSecrets) {
    for (const secret of extraSecrets) {
      // Short strings would fragment surrounding text with little security
      // value (or false positives), so require a minimum length.
      if (typeof secret === "string" && secret.length >= 6) secrets.add(secret);
    }
  }
  // Longest first: a short secret that is a substring of a longer one must
  // not be redacted first and leave the longer one's residue behind. Hoisted
  // out of the returned closure so each telemetry event does not re-allocate
  // and re-sort the secret list.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
    }
    // Pattern-based masking for key shapes that were never in env: a tool
    // can print a key out of the VM's own environment, so the shape alone
    // has to be enough to catch it.
    for (const { pattern, replacement } of SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };
}

/**
 * The secret patterns in a serializable form.
 *
 * The in-VM memory server is generated as source text, and it scrubs
 * secret-shaped strings before a fact even leaves the VM. Generating the
 * patterns from this list keeps the VM-side scrubber and the host-side
 * redactor in step (one source of truth).
 */
export function secretPatternSources(): Array<{ source: string; flags: string; replacement: string }> {
  return SECRET_PATTERNS.map(({ pattern, replacement }) => ({
    source: pattern.source,
    flags: pattern.flags,
    replacement,
  }));
}

/** Deep-copy a value, redacting every string inside it (e.g. tool inputs). */
const MAX_REDACT_DEPTH = 10;

export function redactValue(value: unknown, redact: (text: string) => string): unknown {
  const ancestors = new Set<object>();
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return redact(item);
    if (item === null || typeof item !== "object") return item;
    if (depth >= MAX_REDACT_DEPTH) return "[MAX_DEPTH]";
    if (ancestors.has(item)) return "[CYCLE]";
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map((entry) => walk(entry, depth + 1))
      : (() => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(item)) out[k] = walk(v, depth + 1);
          return out;
        })();
    ancestors.delete(item);
    return result;
  };
  return walk(value, 0);
}
