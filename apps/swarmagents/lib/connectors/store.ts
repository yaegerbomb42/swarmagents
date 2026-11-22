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
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

function libraryItemIdFor(libraryConnectorId: string): string {
  return `connector-${libraryConnectorId}`;
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

  let connected = false;
  if (entry.providerId && entry.libraryConnectorId && entry.vaultSecret) {
    connected = providerConnected && mcpInstalled && vaultConfigured;
  } else if (entry.providerId && entry.vaultSecret) {
    connected = providerConnected && vaultConfigured;
  } else if (entry.providerId && entry.libraryConnectorId) {
    connected = providerConnected && mcpInstalled;
  } else if (entry.providerId) {
    connected = providerConnected;
  } else if (entry.libraryConnectorId) {
    connected = mcpInstalled;
  }

  const canActivateFromProvider = providerConnected && !connected;
  const canOneClickConnect = entry.fields.length === 0 || canActivateFromProvider;

  let mask: string | undefined;
  if (providerKeys.length > 0) {
    mask = maskValue(providerKeys[0]);
  } else if (libItem) {
    mask = libItem.secretFields.find((f) => f.configured && f.mask)?.mask;
  }

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

export async function connectConnector(
  userId: string,
  connectorId: string,
  input: ConnectConnectorInput = {},
): Promise<ConnectorStatusView> {
  const entry = findCatalogConnector(connectorId);
  if (!entry) {
    throw new ConnectorError("Unknown connector.", 404);
  }

  const rawInputs = input.inputs ?? {};
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

  const savedProviders = readConfiguredProviders(userId);
  const existingProvider = entry.providerId
    ? savedProviders.find((p) => p.id === entry.providerId)
    : undefined;

  // Validate provider-specific optional parameters (e.g. Cloudflare accountId -> Workers AI URL).
  let cloudflareBaseUrl: string | undefined;
  if (entry.id === "cloudflare" && cleanedInputs.accountId) {
    if (!SLUG_RE.test(cleanedInputs.accountId)) {
      throw new ConnectorError("Cloudflare Account ID must contain only letters, numbers, '-' or '_'.", 400);
    }
    cloudflareBaseUrl = `https://api.cloudflare.com/client/v4/accounts/${cleanedInputs.accountId}/ai/v1`;
    const safety = validateProviderBaseUrl(cloudflareBaseUrl);
    if (!safety.ok) {
      throw new ConnectorError(safety.error, 400);
    }
  }

  // Resolve primary credential: either freshly submitted or reused server-side from Providers.
  let primaryToken: string | undefined;
  let reusedProviderKey = false;
  const primarySecretField = entry.fields.find((f) => f.secret && f.required);
  if (primarySecretField) {
    const provided = cleanedInputs[primarySecretField.key];
    if (provided) {
      primaryToken = entry.id === "github" ? provided.replace(/^Bearer\s+/i, "").trim() : provided;
    } else if (entry.providerId && existingProvider?.keys && existingProvider.keys.length > 0) {
      primaryToken = existingProvider.keys[0];
      reusedProviderKey = true;
    } else {
      throw new ConnectorError(`${primarySecretField.label} is required.`, 400);
    }
  }

  // Validate library MCP entry ahead of writes so partial state is minimized.
  const mcpCatalogEntry = entry.libraryConnectorId ? connectorById(entry.libraryConnectorId) : null;
  const mcpPayload = mcpCatalogEntry ? connectorPayload(mcpCatalogEntry) : null;
  if (entry.libraryConnectorId && (!mcpCatalogEntry || !mcpPayload)) {
    throw new ConnectorError(`Connector "${entry.id}" MCP definition is unavailable.`, 500);
  }

  // Track writes so any later failure rolls back cleanly.
  let wroteProvider = false;
  let wroteLibrary = false;
  let wroteVault = false;
  const hadProviderBefore = entry.providerId ? savedProviderIds(userId).includes(entry.providerId) : false;

  try {
    if (entry.providerId && primaryToken && !reusedProviderKey) {
      saveProvider(userId, {
        id: entry.providerId,
        apiKey: primaryToken,
        ...(cloudflareBaseUrl ? { baseUrl: cloudflareBaseUrl } : {}),
      });
      wroteProvider = true;
    } else if (entry.providerId && cloudflareBaseUrl && reusedProviderKey) {
      saveProvider(userId, {
        id: entry.providerId,
        baseUrl: cloudflareBaseUrl,
      });
      wroteProvider = true;
    }

    if (entry.libraryConnectorId && mcpCatalogEntry && mcpPayload) {
      const secrets: Record<string, string> = {};
      if (entry.id === "github" && primaryToken) {
        secrets.Authorization = `Bearer ${primaryToken}`;
      } else if (entry.id === "brave-search" && primaryToken) {
        secrets.BRAVE_API_KEY = primaryToken;
      }
      addInstalledItem(userId, {
        id: libraryItemIdFor(entry.libraryConnectorId),
        kind: "connector",
        name: mcpCatalogEntry.name,
        description: mcpCatalogEntry.description,
        payload: mcpPayload,
        secrets,
        origin: "user",
      });
      wroteLibrary = true;
    }

    if (entry.vaultSecret && primaryToken) {
      putSecret(userId, {
        id: entry.vaultSecret.id,
        kind: entry.vaultSecret.kind,
        label: entry.vaultSecret.label,
        plaintext: primaryToken,
      });
      wroteVault = true;
    }
  } catch (err) {
    if (wroteVault && entry.vaultSecret) {
      try {
        deleteSecret(userId, entry.vaultSecret.id);
      } catch {
        // best effort rollback
      }
    }
    if (wroteLibrary && entry.libraryConnectorId) {
      try {
        deleteInstalledItem(userId, libraryItemIdFor(entry.libraryConnectorId));
      } catch {
        // best effort rollback
      }
    }
    if (wroteProvider && entry.providerId && !hadProviderBefore) {
      try {
        removeProvider(userId, entry.providerId);
      } catch {
        // best effort rollback
      }
    }
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
