/**
 * Resolve a publish request body into a payload.
 *
 * Two ways to publish:
 *   - `{ sourceItemId }`: copy one of the caller's own installed items. This
 *     is the path for a tool that has saved secrets — only the payload and
 *     the required-field *names* are copied, never a sealed or clear value.
 *   - `{ kind, name, payload }`: publish inline (e.g. a SKILL.md paste).
 *
 * A request that carries a `secrets` object is rejected outright, and the
 * payload is scanned for secret-shaped keys before it can reach the catalog.
 */

import { LibraryError, assertNoSecretMaterial, clonePayload, isLibraryKind, isRecord, type LibraryKind } from "./types";
import { getStoredItem } from "./user-store";
import type { PublishInput } from "./public-store";

export function resolvePublishInput(ownerId: string, body: unknown, forcedKind?: LibraryKind): PublishInput {
  if (!isRecord(body)) throw new LibraryError("Body must be an object.");
  if ("secrets" in body || "secretValues" in body || "env" in body) {
    throw new LibraryError(
      "Secrets cannot be published. Keep the values in your own library; publish the field names in " +
        "requiredFields so installers can supply their own.",
    );
  }

  if (body.sourceItemId !== undefined) {
    if (typeof body.sourceItemId !== "string" || !body.sourceItemId) {
      throw new LibraryError("sourceItemId must be an item id.");
    }
    const source = getStoredItem(ownerId, body.sourceItemId);
    if (!source) throw new LibraryError("Source item not found in your library.", 404);
    if (forcedKind && source.kind !== forcedKind) {
      throw new LibraryError("The new version must use the same kind as the item.");
    }
    const payload = clonePayload(source.payload);
    assertNoSecretMaterial(payload);
    return {
      kind: forcedKind ?? source.kind,
      name: typeof body.name === "string" ? body.name : source.name,
      description: typeof body.description === "string" ? body.description : source.description,
      license: typeof body.license === "string" ? body.license : source.license ?? "",
      payload,
      ...(typeof body.changelog === "string" ? { changelog: body.changelog } : {}),
    };
  }

  const kind = forcedKind ?? body.kind;
  if (!isLibraryKind(kind)) throw new LibraryError("kind must be skill, tool, mcp or connector.");
  if (body.payload === undefined) throw new LibraryError("payload is required.");
  assertNoSecretMaterial(body.payload);
  return {
    kind,
    name: typeof body.name === "string" ? body.name : "",
    description: typeof body.description === "string" ? body.description : "",
    license: typeof body.license === "string" ? body.license : "",
    payload: body.payload,
    ...(typeof body.changelog === "string" ? { changelog: body.changelog } : {}),
  };
}
