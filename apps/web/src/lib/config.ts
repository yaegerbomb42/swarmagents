/**
 * Central configuration for all environment-driven URLs.
 * All API and WebSocket base URLs should be imported from here — never hardcode.
 *
 * Server-side env vars (no NEXT_PUBLIC_ prefix):
 *   ENGINE_URL          — FastAPI backend base URL
 *   OLLAMA_URL          — Ollama local inference server
 *   BROWSER_BACKEND_URL — Browser automation backend
 *
 * Client-side env vars (NEXT_PUBLIC_ prefix):
 *   NEXT_PUBLIC_ENGINE_URL   — For client-side fetches (via /api/engine rewrite or direct)
 *   NEXT_PUBLIC_ENGINE_WS_URL — WebSocket base URL for browser clients
 *   NEXT_PUBLIC_OLLAMA_URL   — Ollama endpoint accessible from browser (optional)
 */

const isServer = typeof window === 'undefined';

// ─── Engine API base URL ────────────────────────────────────────────────────
// Server-side: uses ENGINE_URL directly (internal docker network)
// Client-side: uses NEXT_PUBLIC_ENGINE_URL or falls back to /api/engine rewrite
export const ENGINE_URL: string = isServer
  ? (process.env.ENGINE_URL || 'http://localhost:8410')
  : (process.env.NEXT_PUBLIC_ENGINE_URL || '/api/engine');

// ─── Engine WebSocket base URL ───────────────────────────────────────────────
// swarm-engine: container listens on 8400 (API_PORT), host publishes 8410
// (deploy.sh: -p 8410:8400). Local dev runs uvicorn on 8400.
export const ENGINE_WS_URL: string = (() => {
  if (!isServer && typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  if (process.env.NEXT_PUBLIC_ENGINE_WS_URL) return process.env.NEXT_PUBLIC_ENGINE_WS_URL;
  if (process.env.NEXT_PUBLIC_ENGINE_URL) {
    return process.env.NEXT_PUBLIC_ENGINE_URL.replace(/^http/, 'ws');
  }
  if (isServer && process.env.ENGINE_URL) {
    return process.env.ENGINE_URL.replace(/^http/, 'ws');
  }
  return 'ws://localhost:8410';
})();

// ─── Ollama base URL ─────────────────────────────────────────────────────────
export const OLLAMA_URL: string = isServer
  ? (process.env.OLLAMA_URL || 'http://localhost:11434')
  : (process.env.NEXT_PUBLIC_OLLAMA_URL || 'http://localhost:11434');

// ─── Browser automation backend ──────────────────────────────────────────────
export const BROWSER_BACKEND_URL: string = isServer
  ? (process.env.BROWSER_BACKEND_URL || 'http://localhost:8002')
  : 'http://localhost:8002';

// ─── Decomposition API base URL ───────────────────────────────────────────────
// Client-side: goes through Next.js /api/engine rewrite
// Server-side: direct to engine
export const DECOMP_API_BASE: string = isServer
  ? `${ENGINE_URL}/api/decomposition`
  : `/api/engine/api/decomposition`;

// ─── WebSocket URL builder ────────────────────────────────────────────────────
export function buildWsUrl(path: string): string {
  const base = ENGINE_WS_URL.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}
