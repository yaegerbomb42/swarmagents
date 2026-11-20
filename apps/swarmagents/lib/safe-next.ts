/**
 * Validation for the `next` redirect parameter used by the login flow.
 *
 * Kept in its own module (no node imports) so the login page can import it
 * in the browser: `lib/auth` pulls in node:crypto and must stay server-only.
 * Only same-origin absolute paths are ever accepted — anything else (a full
 * URL, a protocol-relative `//host`, a backslash, embedded control
 * characters) falls back to "/" so a tampered query param can never turn the
 * post-login redirect into an open redirect.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string") return "/";
  const s = next.trim();
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  // Backslashes and control characters (incl. newline/CR) can smuggle
  // headers or trick naive URL joiners — reject them outright.
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  if (s.length > 2048) return "/";
  return s;
}
