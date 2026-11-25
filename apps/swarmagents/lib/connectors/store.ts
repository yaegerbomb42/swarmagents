/**
 * Server-side per-account Connector Catalog store.
 *
 * Bridges SwarmAgents' real backend primitives so every connector in the UI
 * reflects actual runtime state with zero fake toggles:
 * - LLM provider entries in `lib/providers/store.ts` (models, rate limits, keys)
 * - MCP server definitions in `lib/library/user-store.ts` (--mcp-config seeding)
 * - Secret vault entries in `lib/secrets/registry.ts` (allowlisted HTTP proxy)
 *
 * All reads return sanitized status & masked hints only — sealed secrets never
 * cross to the client.
 */

import { recordAudit } from "../audit";
import { connectorById, connectorPayload } from "../library/catalog";
import {
  addInstalledItem,
  deleteInstalledItem,
  listInstalledItems,
  type InstalledItemView,
} from "../library/user-store";
import {
  readConfiguredProviders,
  removeProvider,
  saveProvider,
  savedProviderIds,
} from "../providers/store";
import { validateProviderBaseUrl } from "../providers/url-safety";
import { deleteSecret, listSecrets, putSecret, type SecretView } from "../secrets/registry";
import type { ProviderConfig } from "../providers/types";
import {
  CONNECTOR_CATALOG,
  findCatalogConnector,
  type ConnectorCatalogEntry,
} from "./catalog";

export class ConnectorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}

export interface ConnectorStatusView extends ConnectorCatalogEntry {
  connected: boolean;
  providerConnected: boolean;
  mcpInstalled: boolean;
  vaultConfigured: boolean;
  /** True when a key is already saved in Providers and just needs 1-click agent activation. */
  canActivateFromProvider: boolean;
  /** True when clicking Connect succeeds without typing a new credential. */
  canOneClickConnect: boolean;
  mask?: string;
}

export interface ConnectConnectorInput {
  inputs?: Record<string, string>;
  useProviderKey?: boolean;
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function isValidCredential(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) return false;
  }
  return true;
}

function libraryItemIdFor(libraryConnectorId: string): string {
  return `connector-${libraryConnectorId}`;
}

function connectedFor(
  entry: ConnectorCatalogEntry,
  providerConnected: boolean,
  mcpInstalled: boolean,
  vaultConfigured: boolean,
): boolean {
  if (entry.providerId && entry.libraryConnectorId && entry.vaultSecret) {
    return providerConnected && mcpInstalled && vaultConfigured;
  }
  if (entry.providerId && entry.vaultSecret) return providerConnected && vaultConfigured;
  if (entry.providerId && entry.libraryConnectorId) return providerConnected && mcpInstalled;
  if (entry.providerId) return providerConnected;
  if (entry.libraryConnectorId) return mcpInstalled;
  return false;
}

function maskFor(
  providerKeys: string[],
  libItem: InstalledItemView | undefined,
): string | undefined {
  if (providerKeys.length > 0) return maskValue(providerKeys[0]);
  if (libItem) return libItem.secretFields.find((f) => f.configured && f.mask)?.mask;
  return undefined;
}

function computeStatusView(
  entry: ConnectorCatalogEntry,
  providersById: ReadonlyMap<string, ProviderConfig>,
  libraryById: ReadonlyMap<string, InstalledItemView>,
  secretsById: ReadonlyMap<string, SecretView>,
): ConnectorStatusView {
  const provider = entry.providerId ? providersById.get(entry.providerId) : undefined;
  const providerKeys = provider?.keys ?? [];
  const providerConnected = Boolean(provider && providerKeys.length > 0);
  const libItem = entry.libraryConnectorId
    ? libraryById.get(libraryItemIdFor(entry.libraryConnectorId))
    : undefined;
  const mcpInstalled = Boolean(libItem);
  const vaultConfigured = entry.vaultSecret
    ? secretsById.has(entry.vaultSecret.id)
    : false;

  const connected = connectedFor(entry, providerConnected, mcpInstalled, vaultConfigured);
  const canActivateFromProvider = providerConnected && !connected;
  const canOneClickConnect = entry.fields.length === 0 || canActivateFromProvider;
  const mask = maskFor(providerKeys, libItem);

  return {
    ...entry,
    connected,
    providerConnected,
    mcpInstalled,
    vaultConfigured,
    canActivateFromProvider,
    canOneClickConnect,
    ...(mask ? { mask } : {}),
  };
}

function buildStatusContext(userId: string) {
  const providersById = new Map<string, ProviderConfig>(
    readConfiguredProviders(userId).map((p) => [p.id, p]),
  );
  const libraryById = new Map<string, InstalledItemView>(
    listInstalledItems(userId).map((item) => [item.id, item]),
  );
  const secretsById = new Map<string, SecretView>(
    listSecrets(userId).map((s) => [s.id, s]),
  );
  return { providersById, libraryById, secretsById };
}

export function listConnectorStatuses(userId: string): ConnectorStatusView[] {
  const { providersById, libraryById, secretsById } = buildStatusContext(userId);
  return CONNECTOR_CATALOG.map((entry) =>
    computeStatusView(entry, providersById, libraryById, secretsById),
  );
}

export function getConnectorStatus(userId: string, connectorId: string): ConnectorStatusView | null {
  const entry = findCatalogConnector(connectorId);
  if (!entry) return null;
  const { providersById, libraryById, secretsById } = buildStatusContext(userId);
  return computeStatusView(entry, providersById, libraryById, secretsById);
}

function cleanConnectInputs(
  entry: ConnectorCatalogEntry,
  rawInputs: Record<string, string>,
): Record<string, string> {
  const cleanedInputs: Record<string, string> = {};
  for (const field of entry.fields) {
    const raw = rawInputs[field.key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new ConnectorError(`${field.label} must be a string.`, 400);
    }
    const trimmed = raw.trim();
    if (trimmed && field.secret && !isValidCredential(trimmed)) {
      throw new ConnectorError(`${field.label} must be 1-512 printable characters.`, 400);
    }
    if (trimmed) cleanedInputs[field.key] = trimmed;
  }
  return cleanedInputs;
}

function resolveCloudflareBaseUrl(
  entry: ConnectorCatalogEntry,
  cleanedInputs: Record<string, string>,
): string | undefined {
  if (entry.id !== "cloudflare" || !cleanedInputs.accountId) return undefined;
  const accountId = cleanedInputs.accountId;
  if (!SLUG_RE.test(accountId)) {
    throw new ConnectorError("Cloudflare Account ID must contain only letters, numbers, '-' or '_'.", 400);
  }
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  const safety = validateProviderBaseUrl(baseUrl);
  if (!safety.ok) throw new ConnectorError(safety.error, 400);
  return baseUrl;
}

interface PrimaryCredential {
  primaryToken: string | undefined;
  reusedProviderKey: boolean;
}

function resolvePrimaryCredential(
  entry: ConnectorCatalogEntry,
  existingProvider: ProviderConfig | undefined,
  cleanedInputs: Record<string, string>,
): PrimaryCredential {
  const primarySecretField = entry.fields.find((f) => f.secret && f.required);
  if (!primarySecretField) {
    for (const field of entry.fields) {
      if (field.required && !cleanedInputs[field.key]) {
        throw new ConnectorError(`${field.label} is required.`, 400);
      }
    }
    return { primaryToken: undefined, reusedProviderKey: false };
  }

  const provided = cleanedInputs[primarySecretField.key];
  if (provided) {
    const primaryToken = entry.id === "github" ? provided.replace(/^Bearer\s+/i, "").trim() : provided;
    for (const field of entry.fields) {
      if (field.required && field.key !== primarySecretField.key && !cleanedInputs[field.key]) {
        throw new ConnectorError(`${field.label} is required.`, 400);
      }
    }
    return { primaryToken, reusedProviderKey: false };
  }
  if (entry.providerId && existingProvider?.keys && existingProvider.keys.length > 0) {
    return { primaryToken: existingProvider.keys[0], reusedProviderKey: true };
  }
  throw new ConnectorError(`${primarySecretField.label} is required.`, 400);
}

interface LibraryPayload {
  catalogEntry: NonNullable<ReturnType<typeof connectorById>>;
  payload: NonNullable<ReturnType<typeof connectorPayload>>;
}

function resolveLibraryPayload(entry: ConnectorCatalogEntry): LibraryPayload | null {
  if (!entry.libraryConnectorId) return null;
  const catalogEntry = connectorById(entry.libraryConnectorId);
  if (!catalogEntry) return null;
  const payload = connectorPayload(catalogEntry);
  if (!payload) return null;
  return { catalogEntry, payload };
}

/**
 * Map the connector's collected inputs onto the MCP server's required fields.
 * Field keys are the server's env/header names (e.g. BRAVE_API_KEY,
 * POSTGRES_URL), so a collected value lands under exactly the name the
 * server reads. The GitHub connector collects its token under `token`
 * while the read-only MCP server expects an Authorization header.
 */
function librarySecretsFor(
  cleanedInputs: Record<string, string>,
  library: LibraryPayload | null,
  primaryToken: string | undefined,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (!library) return secrets;
  for (const field of library.catalogEntry.requiredFields) {
    const supplied = cleanedInputs[field.key];
    if (supplied) {
      secrets[field.key] = supplied;
      continue;
    }
    if (field.key === "Authorization" && primaryToken) {
      secrets.Authorization = `Bearer ${primaryToken}`;
    }
  }
  // Brave Search's server reads BRAVE_API_KEY, not Authorization: reuse a
  // stored/provided key for it, the way the old hardcoded mapping did.
  if (library.catalogEntry.id === "brave-search" && primaryToken && !secrets.BRAVE_API_KEY) {
    secrets.BRAVE_API_KEY = primaryToken;
  }
  return secrets;
}

interface WriteTracker {
  wroteProvider: boolean;
  wroteLibrary: boolean;
  wroteVault: boolean;
  hadProviderBefore: boolean;
}

function writeConnectorSideEffects(
  userId: string,
  entry: ConnectorCatalogEntry,
  opts: {
    cleanedInputs: Record<string, string>;
    primaryToken: string | undefined;
    reusedProviderKey: boolean;
    cloudflareBaseUrl: string | undefined;
    library: LibraryPayload | null;
  },
  writes: WriteTracker,
): void {
  const { primaryToken, reusedProviderKey, cloudflareBaseUrl, library, cleanedInputs } = opts;

  if (entry.providerId && primaryToken && !reusedProviderKey) {
    saveProvider(userId, {
      id: entry.providerId,
      apiKey: primaryToken,
      ...(cloudflareBaseUrl ? { baseUrl: cloudflareBaseUrl } : {}),
    });
    writes.wroteProvider = true;
  } else if (entry.providerId && cloudflareBaseUrl && reusedProviderKey) {
    saveProvider(userId, {
      id: entry.providerId,
      baseUrl: cloudflareBaseUrl,
    });
    writes.wroteProvider = true;
  }

  if (library && entry.libraryConnectorId) {
    addInstalledItem(userId, {
      id: libraryItemIdFor(entry.libraryConnectorId),
      kind: "connector",
      name: library.catalogEntry.name,
      description: library.catalogEntry.description,
      payload: library.payload,
      secrets: librarySecretsFor(cleanedInputs, library, primaryToken),
      origin: "user",
    });
    writes.wroteLibrary = true;
  }

  if (entry.vaultSecret && primaryToken) {
    putSecret(userId, {
      id: entry.vaultSecret.id,
      kind: entry.vaultSecret.kind,
      label: entry.vaultSecret.label,
      plaintext: primaryToken,
    });
    writes.wroteVault = true;
  }
}

function rollbackConnectorWrites(
  userId: string,
  entry: ConnectorCatalogEntry,
  writes: WriteTracker,
): void {
  if (writes.wroteVault && entry.vaultSecret) {
    try {
      deleteSecret(userId, entry.vaultSecret.id);
    } catch {
      // best effort rollback
    }
  }
  if (writes.wroteLibrary && entry.libraryConnectorId) {
    try {
      deleteInstalledItem(userId, libraryItemIdFor(entry.libraryConnectorId));
    } catch {
      // best effort rollback
    }
  }
  if (writes.wroteProvider && entry.providerId && !writes.hadProviderBefore) {
    try {
      removeProvider(userId, entry.providerId);
    } catch {
      // best effort rollback
    }
  }
}

export function connectConnector(
  userId: string,
  connectorId: string,
  input: ConnectConnectorInput = {},
): ConnectorStatusView {
  const entry = findCatalogConnector(connectorId);
  if (!entry) {
    throw new ConnectorError("Unknown connector.", 404);
  }

  const cleanedInputs = cleanConnectInputs(entry, input.inputs ?? {});

  const savedProviders = readConfiguredProviders(userId);
  const existingProvider = entry.providerId
    ? savedProviders.find((p) => p.id === entry.providerId)
    : undefined;

  const cloudflareBaseUrl = resolveCloudflareBaseUrl(entry, cleanedInputs);

  const { primaryToken, reusedProviderKey } = resolvePrimaryCredential(
    entry,
    existingProvider,
    cleanedInputs,
  );

  // Validate the library MCP entry ahead of writes so partial state is minimized.
  const library = resolveLibraryPayload(entry);
  if (entry.libraryConnectorId && !library) {
    throw new ConnectorError(`Connector "${entry.id}" MCP definition is unavailable.`, 500);
  }

  const writes: WriteTracker = {
    wroteProvider: false,
    wroteLibrary: false,
    wroteVault: false,
    hadProviderBefore: entry.providerId ? savedProviderIds(userId).includes(entry.providerId) : false,
  };

  try {
    writeConnectorSideEffects(userId, entry, { primaryToken, reusedProviderKey, cloudflareBaseUrl, library, cleanedInputs }, writes);
  } catch (err) {
    rollbackConnectorWrites(userId, entry, writes);
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(err instanceof Error ? err.message : "Could not connect service.", 400);
  }

  recordAudit({
    user: userId,
    action: "connector.connect",
    target: entry.id,
    result: "success",
  });

  const updated = getConnectorStatus(userId, entry.id);
  if (!updated) throw new ConnectorError("Connector state missing after save.", 500);
  return updated;
}

export function disconnectConnector(
  userId: string,
  connectorId: string,
): { removed: boolean; connector: ConnectorStatusView } {
  const entry = findCatalogConnector(connectorId);
  if (!entry) {
    throw new ConnectorError("Unknown connector.", 404);
  }

  let removed = false;
  if (entry.libraryConnectorId) {
    if (deleteInstalledItem(userId, libraryItemIdFor(entry.libraryConnectorId))) {
      removed = true;
    }
  }
  if (entry.vaultSecret) {
    if (deleteSecret(userId, entry.vaultSecret.id)) {
      removed = true;
    }
  }
  if (entry.providerId && savedProviderIds(userId).includes(entry.providerId)) {
    removeProvider(userId, entry.providerId);
    removed = true;
  }

  recordAudit({
    user: userId,
    action: "connector.disconnect",
    target: entry.id,
    result: "success",
  });

  const connector = getConnectorStatus(userId, entry.id);
  if (!connector) throw new ConnectorError("Unknown connector.", 404);
  return { removed, connector };
}

const REGISTRY_ID_RE = /^[A-Za-z0-9._:/-]{2,120}$/;
const NPM_PKG_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;
const UVX_PKG_RE = /^[A-Za-z0-9._-]+$/;

export interface InstallRegistryMcpInput {
  id: string;
  name: string;
  description?: string;
  transport: "http" | "stdio";
  url?: string;
  packageManager?: "npx" | "uvx";
  packageName?: string;
  env?: Record<string, string>;
}

/**
 * Install an MCP server discovered from the live MCP Registry (or custom URL/package)
 * directly into the user's Library store so it seeds into their VM --mcp-config.
 */
export function installRegistryMcp(
  userId: string,
  input: InstallRegistryMcpInput,
): InstalledItemView {
  const rawId = input.id.trim();
  if (!REGISTRY_ID_RE.test(rawId)) {
    throw new ConnectorError("Invalid MCP server id.", 400);
  }
  const slug = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "mcp";
  const itemId = `registry-${slug}`;
  const name = (input.name || rawId).trim().slice(0, 80);
  const description = (input.description || `Installed MCP server (${rawId}).`).trim().slice(0, 280);

  let payload: Record<string, unknown>;
  if (input.transport === "http") {
    const rawUrl = (input.url ?? "").trim();
    const safety = validateProviderBaseUrl(rawUrl);
    if (!safety.ok) {
      throw new ConnectorError(safety.error || "Invalid remote MCP URL.", 400);
    }
    payload = {
      kind: "connector",
      transport: "http",
      url: rawUrl,
      requiredFields: [],
    };
  } else {
    const pkgMgr = input.packageManager === "uvx" ? "uvx" : "npx";
    const pkg = (input.packageName ?? "").trim();
    if (pkgMgr === "npx" && !NPM_PKG_RE.test(pkg)) {
      throw new ConnectorError("Invalid npm package name for stdio MCP.", 400);
    }
    if (pkgMgr === "uvx" && !UVX_PKG_RE.test(pkg)) {
      throw new ConnectorError("Invalid Python package name for stdio MCP.", 400);
    }
    payload = {
      kind: "connector",
      transport: "stdio",
      command: pkgMgr,
      args: pkgMgr === "npx" ? ["-y", pkg] : [pkg],
      requiredFields: [],
    };
  }

  const installed = addInstalledItem(userId, {
    id: itemId,
    kind: "connector",
    name,
    description,
    payload: payload as Parameters<typeof addInstalledItem>[1]["payload"],
    secrets: {},
    origin: "user",
  });

  recordAudit({
    user: userId,
    action: "connector.connect",
    target: itemId,
    result: "success",
  });

  return installed;
}

/** List installed custom, registry, and agent-authored MCPs/tools (excluding catalog connectors). */
export function listCustomConnectors(userId: string): InstalledItemView[] {
  const catalogLibIds = new Set(
    CONNECTOR_CATALOG.map((c) => (c.libraryConnectorId ? libraryItemIdFor(c.libraryConnectorId) : "")).filter(Boolean),
  );
  return listInstalledItems(userId).filter(
    (item) => !catalogLibIds.has(item.id),
  );
}

export function removeCustomConnector(userId: string, itemId: string): boolean {
  const id = itemId.trim();
  if (!id) throw new ConnectorError("Connector item id is required.", 400);
  const removed = deleteInstalledItem(userId, id);
  if (removed) {
    recordAudit({
      user: userId,
      action: "connector.disconnect",
      target: id,
      result: "success",
    });
  }
  return removed;
}
