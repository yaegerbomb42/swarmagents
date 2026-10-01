import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { HOME } from "./store";

// OAuth for remote MCP servers (Linear, Notion, Sentry…): discovery, dynamic client registration and PKCE
// are done by the MCP SDK; this file persists the results per server in ~/.swarmagents/mcp-auth/<name>.json
// (mode 0600) so tokens survive restarts and refresh automatically during long runs.

const DIR = path.join(HOME, "mcp-auth");

interface Saved {
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensSavedAt?: number;
  verifier?: string;
}

const fileFor = (name: string) => path.join(DIR, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

function load(name: string): Saved {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), "utf8")) as Saved;
  } catch {
    return {};
  }
}

function save(name: string, patch: Partial<Saved>) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const next = { ...load(name), ...patch };
  const f = fileFor(name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export function hasMcpTokens(name: string) {
  return !!load(name).tokens?.access_token;
}

export function forgetMcpAuth(name: string) {
  fs.rmSync(fileFor(name), { force: true });
}

// In-flight logins: OAuth `state` -> server name. Kept on globalThis so dev hot reloads don't drop a login.
const g = globalThis as unknown as { __mcpOAuthStates?: Map<string, { name: string; at: number }> };
export const pendingStates = (g.__mcpOAuthStates ??= new Map());

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK wants the user to sign in; the API route redirects the browser there. */
  authorizationUrl?: URL;
  private readonly stateValue = crypto.randomBytes(16).toString("base64url");

  /** `redirectUrl` is required to start a login; runtime connections reuse the one saved at login. */
  constructor(
    readonly name: string,
    private readonly redirect?: string,
  ) {
    const saved = load(name);
    // Clients are registered for one exact redirect URI; a different origin (localhost vs 127.0.0.1) needs a new one.
    if (redirect && saved.redirectUrl && saved.redirectUrl !== redirect) save(name, { client: undefined, redirectUrl: redirect });
  }

  get redirectUrl() {
    return this.redirect ?? load(this.name).redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Swarm",
      redirect_uris: this.redirectUrl ? [String(this.redirectUrl)] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    pendingStates.set(this.stateValue, { name: this.name, at: Date.now() });
    for (const [k, v] of pendingStates) if (Date.now() - v.at > 15 * 60_000) pendingStates.delete(k);
    return this.stateValue;
  }

  clientInformation() {
    return load(this.name).client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    save(this.name, { client, redirectUrl: this.redirectUrl ? String(this.redirectUrl) : undefined });
  }

  tokens() {
    return load(this.name).tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    save(this.name, { tokens, tokensSavedAt: Date.now() });
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    save(this.name, { verifier });
  }

  codeVerifier() {
    const v = load(this.name).verifier;
    if (!v) throw new Error("No login in progress for this server. Start the sign-in again.");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") forgetMcpAuth(this.name);
    else if (scope === "client") save(this.name, { client: undefined });
    else if (scope === "tokens") save(this.name, { tokens: undefined });
    else if (scope === "verifier") save(this.name, { verifier: undefined });
  }
}
