/**
 * Build a run pool from ONE user's saved provider config — the only place
 * run-pool keys may come from.
 *
 * Never from host env (SWARM_KEYS_*), repo files or any machine path: every
 * provider gets an explicit key list (empty when the user saved none), which
 * stops the Router from falling back to env, and the Router itself is handed
 * an empty env. Inside the long-lived server, prefer passing
 * RuntimeManager#routerForUser(userId) straight to `new RunProviderPool(...)`
 * so key cooldowns persist across runs; this helper is for callers without
 * one (scripts, tests, one-off runs).
 */

import { Router } from "./router";
import type { FetchLike, ProviderConfig } from "./types";
import { routerProviders } from "./store";
import type { DataDirOptions } from "./store";
import { RunProviderPool } from "./run-pool";
import type { RunPoolOptions } from "./run-pool";
import { keySelectionModeFor, readUserSettings } from "./settings";

export interface UserPoolRouterOptions extends DataDirOptions {
  now?: () => number;
  fetch?: FetchLike;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
}

/** The user's providers with keys pinned to what they saved (never env). */
export function userPoolProviders(userId: string, options: DataDirOptions = {}): ProviderConfig[] {
  return routerProviders(userId, { ...options, hostEnvKeys: false }).map((config) => {
    const { envKeys: _envKeys, ...rest } = config;
    void _envKeys;
    return { ...rest, keys: [...(config.keys ?? [])] };
  });
}

export function userPoolRouter(userId: string, options: UserPoolRouterOptions = {}): Router {
  return new Router({
    providers: userPoolProviders(userId, options.env !== undefined ? { env: options.env } : {}),
    env: {},
    raceMode: false,
    ...(options.now ? { now: options.now } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.cooldownBaseMs !== undefined ? { cooldownBaseMs: options.cooldownBaseMs } : {}),
    ...(options.cooldownMaxMs !== undefined ? { cooldownMaxMs: options.cooldownMaxMs } : {}),
    keySelectionMode: keySelectionModeFor(readUserSettings(userId, options)),
  });
}

export function createUserRunPool(
  userId: string,
  poolOptions: RunPoolOptions = {},
  routerOptions: UserPoolRouterOptions = {}
): RunProviderPool {
  return new RunProviderPool(userPoolRouter(userId, routerOptions), poolOptions);
}
