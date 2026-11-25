/**
 * Security response headers for every SwarmAgents page/API response that flows
 * through middleware. Centralized here so the CSP and the nonce flow stay in
 * one place and can be unit-tested without booting Next.
 *
 * Content-Security-Policy is nonce-based: middleware mints a fresh per-request
 * nonce, forwards it in the `x-nonce` request header, and also forwards the
 * policy itself on the request headers — Next.js reads the nonce out of the
 * incoming CSP header and stamps it onto its own inline bootstrap scripts, so
 * every script we did not mint ourselves is blocked. `'unsafe-inline'` is
 * never allowed for scripts; it is only tolerated for styles (CSS cannot
 * execute), and `'unsafe-eval'` is restricted to development where webpack's
 * HMR runtime needs it.
 */

export const NONCE_HEADER = "x-nonce";

export interface SecurityHeadersOptions {
  /** Include `'unsafe-eval'` for the webpack dev runtime (never in prod). */
  dev?: boolean;
  /**
   * Override the `frame-ancestors` directive (default `'none'`). The VM
   * preview proxy (/preview/*) uses `'self'`: the in-app Preview tab is a
   * same-origin iframe, so `'none'` would block it, while `'self'` still
   * keeps every third-party site from framing the preview — including the
   * public share URL. The proxy also re-imposes the same policy on the
   * previewed app's own framing headers, so both layers agree.
   */
  frameAncestors?: string;
}

function directives(nonce: string, dev: boolean, frameAncestors = "'none'"): string[] {
  const script = ["'self'", `'nonce-${nonce}'`];
  if (dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "form-action 'self'",
    `script-src ${script.join(" ")}`,
    // Inline style attributes and Tailwind-injected styles; styles cannot execute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    // Provider calls go straight from the browser to user-configured https
    // endpoints (Anthropic, OpenAI, Gemini, ...), hence https: for connect-src.
    dev
      ? "connect-src 'self' http://127.0.0.1:3778 http://localhost:3778 https: wss: ws:"
      : "connect-src 'self' https: wss: ws:",
    "worker-src 'self' blob:",
  ];
}

/** Build the Content-Security-Policy header value for a request-scoped nonce. */
export function cspValue(nonce: string, opts?: SecurityHeadersOptions): string {
  return directives(nonce, opts?.dev ?? false, opts?.frameAncestors).join("; ");
}

/** All hardening headers, keyed by canonical header name. */
export function securityHeaders(nonce: string, opts?: SecurityHeadersOptions): Record<string, string> {
  const framingSelf = opts?.frameAncestors === "'self'";
  return {
    "content-security-policy": cspValue(nonce, opts),
    "x-content-type-options": "nosniff",
    // Consistent with frame-ancestors: SAMEORIGIN when the page may be
    // framed by its own origin (the preview tab), DENY everywhere else.
    "x-frame-options": framingSelf ? "SAMEORIGIN" : "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), xr-spatial-tracking=(), picture-in-picture=()",
  };
}
