/**
 * Per-account secret registry. Values are sealed with the provider secret box
 * and never returned by list/view helpers.
 */

import fs from "node:fs";
import path from "node:path";
import { open, seal } from "../providers/secret-box";
import { resolveDataDir, userDirName } from "../providers/store";
import { isSecretKind, type SecretKind } from "./allowlist";

export interface SecretRecord {
  id: string;
  kind: SecretKind;
  label: string;
  sealed: string;
  createdAt: string;
}

export interface SecretView {
  id: string;
  kind: SecretKind;
  label: string;
  createdAt: string;
}

interface RegistryFile {
  secrets: SecretRecord[];
}

export interface AwsSecretMaterial {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function filePath(userId: string, env?: Record<string, string | undefined>): string {
  return path.join(resolveDataDir(env ? { env } : {}), "vault", `${userDirName(userId)}.json`);
}

function boxOptions(env?: Record<string, string | undefined>) {
  return {
    ...(env ? { env } : {}),
    dataDir: resolveDataDir(env ? { env } : {}),
  };
}

function readFile(userId: string, env?: Record<string, string | undefined>): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(userId, env), "utf8")) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.secrets)) return { secrets: [] };
    return parsed;
  } catch {
    return { secrets: [] };
  }
}

function writeFile(userId: string, file: RegistryFile, env?: Record<string, string | undefined>): void {
  const target = filePath(userId, env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(file), { mode: 0o600 });
}

export function listSecrets(userId: string, env?: Record<string, string | undefined>): SecretView[] {
  return readFile(userId, env).secrets
    .filter((s) => isSecretKind(s.kind))
    .map((s) => ({ id: s.id, kind: s.kind, label: s.label, createdAt: s.createdAt }));
}

export function putSecret(
  userId: string,
  input: { id: string; kind: SecretKind; label: string; plaintext: string },
  env?: Record<string, string | undefined>,
): SecretView {
  if (!ID_RE.test(input.id)) throw new Error("Secret id must be a short slug.");
  if (!input.plaintext.trim()) throw new Error("Secret value is empty.");
  if (input.plaintext.length > 8192) throw new Error("Secret value is too long.");
  const file = readFile(userId, env);
  const record: SecretRecord = {
    id: input.id,
    kind: input.kind,
    label: input.label.slice(0, 80),
    sealed: seal(input.plaintext, userId, `vault:${input.id}`, boxOptions(env)),
    createdAt: new Date().toISOString(),
  };
  const idx = file.secrets.findIndex((s) => s.id === input.id);
  if (idx >= 0) file.secrets[idx] = record;
  else file.secrets.push(record);
  writeFile(userId, file, env);
  return { id: record.id, kind: record.kind, label: record.label, createdAt: record.createdAt };
}

/** Server-side only. Opens one sealed secret for an allowlisted proxy hop. */
export function openSecret(
  userId: string,
  id: string,
  env?: Record<string, string | undefined>,
): { kind: SecretKind; plaintext: string } | null {
  const record = readFile(userId, env).secrets.find((s) => s.id === id);
  if (!record || !isSecretKind(record.kind)) return null;
  const plaintext = open(record.sealed, userId, `vault:${record.id}`, boxOptions(env));
  return { kind: record.kind, plaintext };
}

/** Remove one sealed secret from the caller's vault. Returns true if it existed. */
export function deleteSecret(
  userId: string,
  id: string,
  env?: Record<string, string | undefined>,
): boolean {
  if (!ID_RE.test(id)) return false;
  const file = readFile(userId, env);
  const next = file.secrets.filter((s) => s.id !== id);
  if (next.length === file.secrets.length) return false;
  writeFile(userId, { secrets: next }, env);
  return true;
}

export function parseAwsMaterial(plaintext: string): AwsSecretMaterial {
  const parsed = JSON.parse(plaintext) as AwsSecretMaterial;
  if (!parsed || typeof parsed.accessKeyId !== "string" || typeof parsed.secretAccessKey !== "string") {
    throw new Error("AWS secret must be JSON with accessKeyId and secretAccessKey.");
  }
  return parsed;
}
