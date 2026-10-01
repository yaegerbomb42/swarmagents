/** Single canonical origin for the local app (127.0.0.1), so localStorage
 *  (e.g. last-open session) and the OAuth callback landing never split
 *  across localhost vs 127.0.0.1. Runs in the browser; server middleware
 *  cannot do this (redirect Locations get host-normalized → loop). */
export function canonicalHostSwap(href: string): string | null {
  const u = new URL(href);
  if (u.hostname !== "localhost") return null;
  u.hostname = "127.0.0.1";
  return u.toString();
}
