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
  // PEM private key headers (the body stays, but the header alone marks the
  // material as a private key; mask it so logs never carry the shape).
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED]" },
  // Authorization headers: keep the scheme, mask the credential.
  { pattern: /Bearer [A-Za-z0-9._~+\-/=]{10,}/gi, replacement: "Bearer [REDACTED]" },
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
      if (typeof secret === "string" && secret.length > 0) secrets.add(secret);
    }
  }
  return (text) => {
    let out = text;
    // Longest first: a short secret that is a substring of a longer one must
    // not be redacted first and leave the longer one's residue behind.
    const ordered = [...secrets].sort((a, b) => b.length - a.length);
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
export function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, redact);
    return out;
  }
  return value;
}
