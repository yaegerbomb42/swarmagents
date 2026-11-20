/**
 * The verified connector catalog (lib/library/catalog/connectors.json), as a
 * typed, server-safe module.
 *
 * Each entry is an MCP server with a documented transport and, when useful,
 * the field names a user must supply. Values are never part of the catalog;
 * the user fills them into their own account and they are sealed there.
 */

import rawConnectors from "./catalog/connectors.json";
import { isRecord, type McpPayload } from "./types";

export interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  helpUrl?: string;
}

export interface ConnectorEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  transport: "stdio" | "http";
  /** A remote endpoint or install command/package, from the catalog. */
  install: string;
  requiredFields: ConnectorField[];
  auth: string;
  tools: string[];
  sourceUrl?: string;
  verified: boolean;
  verifiedHow?: string;
}

function normalize(raw: unknown): ConnectorEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const transport = raw.transport === "stdio" ? "stdio" : "http";
  const fields: ConnectorField[] = Array.isArray(raw.requiredFields)
    ? raw.requiredFields
        .filter((field): field is Record<string, unknown> => isRecord(field))
        .map((field) => ({
          key: String(field.key ?? ""),
          label: String(field.label ?? field.key ?? ""),
          secret: field.secret === true,
          ...(typeof field.helpUrl === "string" ? { helpUrl: field.helpUrl } : {}),
        }))
        .filter((field) => field.key)
    : [];
  return {
    id: raw.id,
    name: raw.name,
    category: typeof raw.category === "string" ? raw.category : "other",
    description: typeof raw.description === "string" ? raw.description : "",
    transport,
    install: typeof raw.install === "string" ? raw.install : "",
    requiredFields: fields,
    auth: typeof raw.auth === "string" ? raw.auth : "",
    tools: Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string") : [],
    ...(typeof raw.sourceUrl === "string" ? { sourceUrl: raw.sourceUrl } : {}),
    verified: raw.verified === true,
    ...(typeof raw.verifiedHow === "string" ? { verifiedHow: raw.verifiedHow } : {}),
  };
}

export const CONNECTORS: readonly ConnectorEntry[] = (Array.isArray(rawConnectors) ? rawConnectors : [])
  .map(normalize)
  .filter((entry): entry is ConnectorEntry => entry !== null);

export function connectorById(id: string): ConnectorEntry | null {
  return CONNECTORS.find((entry) => entry.id === id) ?? null;
}

/**
 * Turn a catalog connector into an installable MCP payload. Only HTTP
 * connectors with a concrete endpoint and stdio connectors whose `install`
 * is a command are offered; the field list becomes the installer's required
 * fields (values still have to be supplied by the installer).
 */
export function connectorPayload(entry: ConnectorEntry): McpPayload | null {
  const requiredFields = entry.requiredFields.map((field) => ({
    key: field.key,
    label: field.label,
    ...(field.helpUrl ? { helpUrl: field.helpUrl } : {}),
  }));
  if (entry.transport === "http") {
    if (!/^https?:\/\//i.test(entry.install)) return null;
    return {
      kind: "connector",
      transport: "http",
      url: entry.install,
      requiredFields,
      ...(entry.tools.length ? { tools: entry.tools } : {}),
    };
  }
  const parts = entry.install.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    kind: "connector",
    transport: "stdio",
    command: parts[0],
    args: parts.slice(1),
    requiredFields,
    ...(entry.tools.length ? { tools: entry.tools } : {}),
  };
}
