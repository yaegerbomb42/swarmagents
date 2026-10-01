// Helpers for routes that build absolute URLs (OAuth redirect URIs) or redirect the browser.
// Behind a reverse proxy, req.url is the internal address (http://host:3400), so prefer forwarded headers.

export function publicOrigin(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || u.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || u.host;
  return `${proto}://${host}`;
}

/** Redirect with a relative Location so it works on any host the browser used. */
export function redirectTo(location: string, status = 303) {
  return new Response(null, { status, headers: { Location: location } });
}
