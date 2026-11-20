/**
 * Local credential store of the runner.
 *
 * The device token is written once (after pairing) and read on every start.
 * It lives in a 0600 file in the user's home directory and is never printed
 * or logged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the runner remembers between restarts. */
export interface NodeCredentials {
  /** The server the node belongs to. */
  server: string;
  /** The per-device token (never logged). */
  token: string;
  /** The node name shown in the app. */
  name?: string;
  /** Paired at (epoch ms). */
  pairedAt?: number;
}

/** Default directory for the runner's state. */
export function defaultStateDir(): string {
  return process.env.SWARM_NODE_HOME ?? path.join(os.homedir(), ".swarm-node");
}

/** Default credentials file. */
export function defaultCredentialsFile(): string {
  return path.join(defaultStateDir(), "credentials.json");
}

/** Read the stored credentials (null when there are none). */
export function loadCredentials(file: string = defaultCredentialsFile()): NodeCredentials | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as NodeCredentials;
    if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Store the credentials with owner-only permissions. */
export function saveCredentials(
  credentials: NodeCredentials,
  file: string = defaultCredentialsFile(),
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Forget the stored credentials. */
export function clearCredentials(file: string = defaultCredentialsFile()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
