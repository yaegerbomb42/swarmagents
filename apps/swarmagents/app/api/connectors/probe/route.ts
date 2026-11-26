/**
 * Live health + tool-schema probe for one connector or custom MCP server.
 *
 * The caller only sends an id: the server resolves the installed item, opens
 * its sealed secrets in memory and probes the MCP endpoint. The response is
 * never cached and carries only ok/latency/tool names — no headers, env, URLs,
 * upstream error text or secret values.
 */

import { findCatalogConnector } from "@/lib/connectors/catalog";
import { buildProbeTarget, probeConnectorHealth } from "@/lib/connectors/health-probe";
import { noStoreJson, readJsonObject } from "@/lib/http";
import { getStoredItem, requireItemSecrets } from "@/lib/library/user-store";
import type { McpPayload } from "@/lib/library/types";
import { providerOwner } from "@/lib/providers/owner";
import { checkProviderProbeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isMcpPayload(payload: unknown): payload is McpPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    (candidate.kind === "mcp" || candidate.kind === "connector") &&
    (candidate.transport === "http" || candidate.transport === "stdio")
  );
}

export async function POST(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return noStoreJson({ error: "Sign in required." }, { status: 401 });

  // A probe triggers a live outbound call (or a VM exec): bound it per user.
  const limit = checkProviderProbeRateLimit(owner);
  if (!limit.allowed) {
    return noStoreJson(
      { error: "Too many connector tests. Try again later." },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } },
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const rawId = parsed.value.connectorId;
  if (typeof rawId !== "string" || !rawId.trim() || rawId.length > 256) {
    return noStoreJson({ error: "connectorId is required." }, { status: 400 });
  }
  const connectorId = rawId.trim();

  // Custom / agent-authored / registry-installed MCPs are stored directly.
  // Catalog connectors are installed under `connector-<libraryConnectorId>`.
  let item = getStoredItem(owner, connectorId);
  if (!item) {
    const catalog = findCatalogConnector(connectorId);
    if (catalog?.libraryConnectorId) {
      item = getStoredItem(owner, `connector-${catalog.libraryConnectorId}`);
    }
  }
  if (!item) {
    return noStoreJson({ error: "Connector is not installed for this account." }, { status: 404 });
  }
  if (!isMcpPayload(item.payload)) {
    return noStoreJson({ error: "This connector has no MCP endpoint to probe." }, { status: 400 });
  }

  let target;
  try {
    const secrets = requireItemSecrets(owner, item);
    target = buildProbeTarget(item.payload, secrets);
  } catch {
    // The failure names a field, never a value; do not echo even that detail.
    return noStoreJson(
      { error: "Connector credentials could not be opened." },
      { status: 400 },
    );
  }

  const probe = await probeConnectorHealth(target, { userId: owner });
  return noStoreJson({ probe });
}
