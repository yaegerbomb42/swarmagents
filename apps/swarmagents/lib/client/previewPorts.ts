/**
 * previewPorts.ts — client helper for detecting listening web-app ports in the
 * user's VM via GET /api/runtime/vm/preview/ports.
 */

export const PREVIEW_PORTS_ENDPOINT = "/api/runtime/vm/preview/ports";

const PREFERRED_WEB_PORTS = [3000, 5173, 4173, 8080, 8000, 4000, 3001, 8888];

export interface ListeningPortsResult {
  running: boolean;
  ports: number[];
}

/** Pick the most likely web-app port from detected listening TCP ports. */
export function pickPrimaryPreviewPort(ports: readonly number[]): number | null {
  if (ports.length === 0) return null;
  for (const preferred of PREFERRED_WEB_PORTS) {
    if (ports.includes(preferred)) return preferred;
  }
  return [...ports].sort((a, b) => a - b)[0] ?? null;
}

/** Build the session-gated preview proxy URL for a detected port. */
export function previewHrefForPort(port: number): string {
  return `/preview/${port}/`;
}

/** Fetch currently listening previewable ports from the runtime API. Never throws. */
export async function fetchListeningPorts(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ListeningPortsResult> {
  try {
    const res = await fetchImpl(PREVIEW_PORTS_ENDPOINT, { cache: "no-store", signal });
    if (!res.ok) return { running: false, ports: [] };
    const body = (await res.json().catch(() => null)) as
      | { running?: unknown; ports?: unknown }
      | null;
    const running = body?.running === true;
    const ports = Array.isArray(body?.ports)
      ? body.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535)
      : [];
    return { running, ports };
  } catch {
    return { running: false, ports: [] };
  }
}
