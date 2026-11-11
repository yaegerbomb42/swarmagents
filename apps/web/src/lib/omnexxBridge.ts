/**
 * Server-only loader for the Omnexx engine bridge (packages/engine/src/swarmagents-bridge.ts).
 *
 * The engine is bundled into one ESM file by `npm run build:bridge` in packages/engine
 * (dist/bridge.mjs). The Docker image copies it to /app/engine/bridge.mjs. It is loaded at
 * runtime with a native import so webpack never tries to bundle the engine into Next.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BridgeTelemetryEvent {
  seq: number;
  ts: number;
  taskId: string;
  type: string;
  [key: string]: unknown;
}

export interface BridgeTask {
  id: string;
  title: string;
  description: string;
  provider?: string;
  model?: string;
  budget?: number;
}

export interface BridgeResult {
  taskId: string;
  status: 'completed' | 'failed' | 'paused';
  stepsExecuted: number;
  finalText: string;
  files: { path: string; content: string; bytes: number }[];
  end: string;
  error?: string;
  durationMs: number;
}

export interface BridgeModule {
  OmnexxSwarmBridge: {
    new (config?: { workingDir?: string; defaultProvider?: string }): {
      executeTask(
        task: BridgeTask,
        opts?: {
          onEvent?: (e: BridgeTelemetryEvent) => void;
          signal?: AbortSignal;
          maxTurns?: number;
          deadlineMs?: number;
        },
      ): Promise<BridgeResult>;
    };
    clusters(env?: Record<string, string | undefined>): {
      name: string;
      label: string;
      model: string;
      keys: number;
    }[];
  };
}

export function bridgeCandidates(): string[] {
  const cwd = process.cwd();
  return [
    process.env.OMNEXX_BRIDGE_PATH,
    join(cwd, 'engine', 'bridge.mjs'),
    resolve(cwd, '..', '..', 'packages', 'engine', 'dist', 'bridge.mjs'),
  ].filter((p): p is string => Boolean(p));
}

let cached: Promise<BridgeModule> | null = null;

export function loadBridge(): Promise<BridgeModule> {
  if (!cached) {
    const path = bridgeCandidates().find((p) => existsSync(p));
    if (!path) {
      return Promise.reject(
        new Error(
          'Omnexx bridge bundle not found. Run `npm run build:bridge` in packages/engine or set OMNEXX_BRIDGE_PATH.',
        ),
      );
    }
    cached = import(/* webpackIgnore: true */ pathToFileURL(path).href) as Promise<BridgeModule>;
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
