import { createHash } from 'node:crypto';

export interface ExecutionVector {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface BehavioralCandidate {
  id?: string | number;
  patch?: string;
  patchDiff?: string;
  outputs?: ExecutionVector[];
  executionVectors?: ExecutionVector[];
  signature?: string;
  behavioralSignature?: string;
  [key: string]: unknown;
}

export interface BehavioralCluster<T = unknown> {
  signature: string;
  members: T[];
  representative: T;
}

export type Cluster<T = unknown> = BehavioralCluster<T>;

/** Hash a list of execution vectors into a stable behavioral signature token. */
export function hashExecutionVectors(vectors: ExecutionVector[]): string {
  const normalized = vectors
    .map((v) => `${v.exitCode ?? 0}\u0000${v.stdout}\u0000${v.stderr}`)
    .join('\u0001');
  return createHash('sha256').update(normalized).digest('hex');
}

export function behavioralHash(vectors: ExecutionVector[]): string {
  return hashExecutionVectors(vectors);
}

export function computeBehavioralSignature(candidate: BehavioralCandidate): string {
  if (candidate.signature) return candidate.signature;
  if (candidate.behavioralSignature) return candidate.behavioralSignature;
  const vectors = candidate.outputs ?? candidate.executionVectors ?? [];
  return hashExecutionVectors(vectors);
}

export function candidateSignature(candidate: unknown): string {
  const c = candidate as BehavioralCandidate;
  return computeBehavioralSignature(c);
}

/** Group candidates by identical behavioral signature; pick one representative per cluster. */
export function clusterCandidates<T = unknown>(
  candidates: T[],
  signatureOf: (c: T) => string = (c) => candidateSignature(c),
): BehavioralCluster<T>[] {
  const groups = new Map<string, T[]>();
  for (const c of candidates) {
    const sig = signatureOf(c);
    const arr = groups.get(sig) ?? [];
    arr.push(c);
    groups.set(sig, arr);
  }
  const clusters: BehavioralCluster<T>[] = [];
  for (const [sig, members] of groups) {
    clusters.push({ signature: sig, members, representative: members[0] as T });
  }
  return clusters;
}

export const clusterByBehavior = clusterCandidates;
export const groupByBehavioralSignature = clusterCandidates;

/** Flatten representatives (one per cluster) for downstream regression runs. */
export function selectRepresentatives<T = unknown>(clusters: BehavioralCluster<T>[]): T[] {
  return clusters.map((c) => c.representative);
}

export function selectRepresentative<T = unknown>(clusters: BehavioralCluster<T>[]): T[] {
  return selectRepresentatives(clusters);
}

export function clusterPatches<T = unknown>(candidates: T[]): BehavioralCluster<T>[] {
  return clusterCandidates(candidates);
}
