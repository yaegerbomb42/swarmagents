import path from "node:path";
import fs from "node:fs";

/**
 * GitHub OAuth & Device Code Flow for SwarmAgents.
 * Allows connecting GitHub account via OAuth PKCE or Device Code flow
 * for personal access tokens / app installations.
 * Uses dynamic accessor to support multi-tenant isolation safely.
 */

export function getAuthDir(): string {
  return process.env.SWARM_HOME || path.join(process.env.HOME || "/tmp", ".swarmagents");
}

export function getGitHubAuthFile(): string {
  return path.join(getAuthDir(), "github-auth.json");
}

export interface GitHubAuthTokens {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  savedAt: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function saveGitHubTokens(tokens: GitHubAuthTokens): void {
  const dir = getAuthDir();
  const file = getGitHubAuthFile();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadGitHubTokens(): GitHubAuthTokens | null {
  try {
    return JSON.parse(fs.readFileSync(getGitHubAuthFile(), "utf8")) as GitHubAuthTokens;
  } catch {
    return null;
  }
}

export function clearGitHubTokens(): void {
  fs.rmSync(getGitHubAuthFile(), { force: true });
}

/**
 * Initiate Device Code flow with GitHub OAuth.
 */
export async function startDeviceCodeFlow(clientId: string, scope = "repo,read:user"): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`GitHub Device Code initiation failed: ${res.statusText}`);
  }

  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Poll GitHub Device Code token endpoint.
 */
export async function pollDeviceCodeToken(clientId: string, deviceCode: string): Promise<{ access_token?: string; error?: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Device code polling error: ${res.statusText}`);
  }

  return (await res.json()) as { access_token?: string; error?: string };
}
