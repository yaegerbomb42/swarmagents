/**
 * The Nemotron (NVIDIA NIM) and Mercury (Inception) key clusters, configured from env vars.
 *
 * Keys are read from the environment only, never from the repository:
 *   NVIDIA_API_KEYS="k1,k2,..."  or  NVIDIA_API_KEY  or  NVIDIA_API_KEY_1..NVIDIA_API_KEY_N
 *   INCEPTION_API_KEYS="k1,k2"   or  INCEPTION_API_KEY  or  INCEPTION_API_KEY_1..N
 * Optional overrides: NEMOTRON_MODEL, NEMOTRON_BASE_URL, MERCURY_MODEL, MERCURY_BASE_URL,
 * SWARM_RACE_WIDTH (keys raced per call; default 4 for Nemotron, 2 for Mercury).
 */
import { ClusterRouter, KeyCluster, type KeyClusterEvent } from './key-cluster.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface ClusterTemplate {
  name: 'nemotron' | 'mercury';
  label: string;
  envPrefix: string;
  baseUrl: string;
  model: string;
  /** Max output tokens the model accepts comfortably. */
  maxTokens: number;
  /** Keys raced per call unless SWARM_RACE_WIDTH overrides it. */
  raceWidth: number;
}

export const CLUSTER_TEMPLATES: Record<ClusterTemplate['name'], ClusterTemplate> = {
  nemotron: {
    name: 'nemotron',
    label: 'NVIDIA Nemotron 3 Ultra',
    envPrefix: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    maxTokens: 8_192,
    // NIM's Nemotron replicas intermittently return garbled tokens; a wider race hides that.
    raceWidth: 4,
  },
  mercury: {
    name: 'mercury',
    label: 'Inception Mercury 3',
    envPrefix: 'INCEPTION',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    model: 'mercury-3',
    maxTokens: 8_192,
    raceWidth: 2,
  },
};

/** Every key for `prefix` in env: `<P>_API_KEYS` (comma/space/newline list), `<P>_API_KEY`, `<P>_API_KEY_<n>`. */
export function keysFromEnv(env: Env, prefix: string): string[] {
  const out: string[] = [];
  const list = env[`${prefix}_API_KEYS`];
  if (list) out.push(...list.split(/[\s,;]+/));
  const single = env[`${prefix}_API_KEY`];
  if (single) out.push(single);
  const numbered = Object.keys(env)
    .map((k) => new RegExp(`^${prefix}_API_KEY_(\\d+)$`).exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  for (const m of numbered) {
    const v = env[m[0]];
    if (v) out.push(v);
  }
  return [...new Set(out.map((k) => k.trim()).filter(Boolean))];
}

export interface ClusterSummary {
  name: string;
  label: string;
  model: string;
  keys: number;
}

export function clusterSummaries(env: Env): ClusterSummary[] {
  return Object.values(CLUSTER_TEMPLATES).map((t) => ({
    name: t.name,
    label: t.label,
    model: env[`${t.name.toUpperCase()}_MODEL`] ?? t.model,
    keys: keysFromEnv(env, t.envPrefix).length,
  }));
}

export function buildClusters(
  env: Env,
  opts: { onEvent?: (e: KeyClusterEvent) => void; fetch?: typeof fetch; only?: readonly string[] } = {},
): KeyCluster[] {
  const override = Number(env['SWARM_RACE_WIDTH'] ?? 0) || 0;
  return Object.values(CLUSTER_TEMPLATES)
    .filter((t) => !opts.only || opts.only.includes(t.name))
    .flatMap((t) => {
      const keys = keysFromEnv(env, t.envPrefix);
      if (keys.length === 0) return [];
      const up = t.name.toUpperCase();
      return [
        new KeyCluster({
          name: t.name,
          baseUrl: env[`${up}_BASE_URL`] ?? t.baseUrl,
          model: env[`${up}_MODEL`] ?? t.model,
          keys,
          raceWidth: Math.min(override || t.raceWidth, keys.length),
          ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        }),
      ];
    });
}

export function buildRouter(
  env: Env,
  opts: Parameters<typeof buildClusters>[1] & { race?: boolean } = {},
): ClusterRouter | undefined {
  const clusters = buildClusters(env, opts);
  return clusters.length ? new ClusterRouter(clusters, { race: opts.race ?? false }) : undefined;
}

export { ClusterRouter, KeyCluster } from './key-cluster.js';
export type { KeyClusterEvent, KeyStat } from './key-cluster.js';
