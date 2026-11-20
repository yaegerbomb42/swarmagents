/**
 * Provider key mutations shared by the provider API routes.
 *
 * Both `PATCH /api/providers/[id]` and `PATCH /api/providers` funnel through
 * here, so both accept the same payload and answer with the same shape.
 *
 * The payload never echoes back: a mutation answers with a key count and
 * last-4 masks only.
 */

import {
  addProviderKey,
  moveProviderRank,
  ProviderMutationError,
  removeProvider,
  removeProviderKey,
  rotateProviderKey,
  setProviderBilling,
  setProviderRank,
  type ProviderBillingPatch,
  type ProviderKeyMutation,
} from "./store";
import type { ProviderKeySlot } from "./keys";
import { providerRow, type ProviderRow } from "./rows";
import { recordAudit, type AuditAction } from "../audit";

export type ProviderKeyAction = "add-key" | "remove-key" | "rotate-key";

export type ProviderRankAction = "set-rank" | "move-up" | "move-down";

export type ProviderBillingAction = "free" | "paid" | "set-prices";

export interface RankMutationRequest {
  action: ProviderRankAction;
  /** New rank for `set-rank`; must be a number >= 0. */
  rank?: number;
}

const RANK_ACTIONS: Record<string, ProviderRankAction> = {
  "set-rank": "set-rank",
  set: "set-rank",
  "move-up": "move-up",
  up: "move-up",
  "move-down": "move-down",
  down: "move-down",
};

const BILLING_ACTIONS: Record<string, ProviderBillingAction> = {
  free: "free",
  "mark-free": "free",
  paid: "paid",
  "mark-paid": "paid",
  "set-prices": "set-prices",
  prices: "set-prices",
};

function readBillingAction(input: Record<string, unknown>): ProviderBillingAction | undefined {
  const raw = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  if (BILLING_ACTIONS[raw]) return BILLING_ACTIONS[raw];
  if (raw === "" && typeof input.isFree === "boolean") {
    return input.isFree ? "free" : "paid";
  }
  return undefined;
}

/** Validate a billing/free-flag payload. */
export function parseBillingMutation(body: unknown): ProviderBillingPatch {
  const input = objectBody(body);
  const action = readBillingAction(input);
  if (!action) {
    throw new ProviderMutationError(
      'action must be "free", "paid" or "set-prices".',
      400
    );
  }
  if (action === "free") return { isFree: true };
  if (action === "paid") return { isFree: false };
  const inputPrice = input.inputPricePer1mTokens;
  const outputPrice = input.outputPricePer1mTokens;
  const validPrice = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!validPrice(inputPrice) || !validPrice(outputPrice)) {
    throw new ProviderMutationError(
      "set-prices requires non-negative numeric inputPricePer1mTokens and outputPricePer1mTokens.",
      400
    );
  }
  return {
    inputPricePer1mTokens: inputPrice,
    outputPricePer1mTokens: outputPrice,
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderMutationError("Body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

function readRankAction(input: Record<string, unknown>): ProviderRankAction | undefined {
  const raw = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  if (RANK_ACTIONS[raw]) return RANK_ACTIONS[raw];
  // `PATCH {rank: 2}` is a convenient shorthand for `{action:"set-rank", rank}`.
  if (raw === "" && input.rank !== undefined) return "set-rank";
  return undefined;
}

/** Validate a provider rank/reorder payload. */
export function parseRankMutation(body: unknown): RankMutationRequest {
  const input = objectBody(body);
  const action = readRankAction(input);
  if (!action) {
    throw new ProviderMutationError(
      'action must be "set-rank", "move-up" or "move-down".',
      400
    );
  }
  if (action !== "set-rank") return { action };
  const rank = input.rank;
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 0) {
    throw new ProviderMutationError("Rank must be a number greater than or equal to 0.", 400);
  }
  return { action, rank };
}

export interface KeyMutationRequest {
  action: ProviderKeyAction;
  /** Position of the key slot to remove or rotate. */
  index?: number;
  /** The new key value. Server-side only — never returned. */
  apiKey?: string;
}

/** A key is 1-512 printable ASCII characters. */
export function isValidProviderKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

const ACTIONS: Record<string, ProviderKeyAction> = {
  "add-key": "add-key",
  add: "add-key",
  "remove-key": "remove-key",
  remove: "remove-key",
  "rotate-key": "rotate-key",
  rotate: "rotate-key",
};

function readIndex(input: Record<string, unknown>): number {
  const index = input.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new ProviderMutationError("index must be a non-negative integer.", 400);
  }
  return index;
}

/** Validate a key-mutation payload. */
export function parseKeyMutation(body: unknown): KeyMutationRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderMutationError("Body must be a JSON object.", 400);
  }
  const input = body as Record<string, unknown>;
  const rawAction = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  const action = ACTIONS[rawAction];
  if (!action) {
    throw new ProviderMutationError(
      'action must be "add-key", "remove-key" or "rotate-key".',
      400
    );
  }

  if (action === "remove-key") {
    return { action, index: readIndex(input) };
  }

  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  if (!isValidProviderKey(apiKey)) {
    throw new ProviderMutationError("API key must be 1-512 printable characters.", 400);
  }
  if (action === "rotate-key") {
    return { action, index: readIndex(input), apiKey };
  }
  return { action, apiKey };
}

export interface KeyMutationResult {
  provider: ProviderRow;
  keyCount: number;
  /** One slot per key: its index and a last-4 mask. */
  keySlots: ProviderKeySlot[];
}

/** Apply a validated key mutation to a saved provider. */
export function applyKeyMutation(userId: string, id: string, body: unknown): KeyMutationResult {
  return applyParsedKeyMutation(userId, id, parseKeyMutation(body));
}

/** Apply an already-parsed key mutation to a saved provider. */
export function applyParsedKeyMutation(
  userId: string,
  id: string,
  request: KeyMutationRequest
): KeyMutationResult {
  let mutation: ProviderKeyMutation;
  switch (request.action) {
    case "add-key":
      mutation = addProviderKey(userId, id, request.apiKey ?? "");
      break;
    case "remove-key":
      mutation = removeProviderKey(userId, id, request.index ?? 0);
      break;
    case "rotate-key":
      mutation = rotateProviderKey(userId, id, request.index ?? 0, request.apiKey ?? "");
      break;
  }
  const row = providerRow(mutation.provider, { saved: true });
  return { provider: row, keyCount: row.keyCount, keySlots: row.keySlots };
}

/** A ready-to-send API answer (status + body). */
export interface MutationResponse {
  status: number;
  body: Record<string, unknown>;
}

function failure(err: unknown): MutationResponse {
  if (err instanceof ProviderMutationError) {
    return { status: err.status, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[providers] provider mutation failed: ${message}`);
  return { status: 500, body: { error: "Could not update the provider." } };
}

const KEY_AUDIT_ACTIONS: Record<ProviderKeyAction, AuditAction> = {
  "add-key": "provider.key.add",
  "remove-key": "provider.key.remove",
  "rotate-key": "provider.key.rotate",
};

/**
 * Apply a key mutation to one of `user`'s providers and shape the response.
 * The body never contains key material — only a key count and last-4 masks.
 * The mutation is audit-logged as `user` (target is the provider id; no key
 * material).
 */
export function runKeyMutation(user: string, id: string, body: unknown): MutationResponse {
  const rankAction =
    body && typeof body === "object" && !Array.isArray(body)
      ? readRankAction(body as Record<string, unknown>)
      : undefined;
  if (rankAction) return runProviderRankMutation(user, id, body);
  const billingAction =
    body && typeof body === "object" && !Array.isArray(body)
      ? readBillingAction(body as Record<string, unknown>)
      : undefined;
  if (billingAction) return runProviderBillingMutation(user, id, body);

  let request: KeyMutationRequest | null = null;
  try {
    request = parseKeyMutation(body);
    const result = applyParsedKeyMutation(user, id, request);
    if (user) {
      recordAudit({ user, action: KEY_AUDIT_ACTIONS[request.action], target: id, result: "success" });
    }
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    if (user && request) {
      recordAudit({ user, action: KEY_AUDIT_ACTIONS[request.action], target: id, result: "failure" });
    }
    return failure(err);
  }
}

export interface RankMutationResult {
  provider: ProviderRow;
  rank: number;
}

/** Apply a validated rank/reorder mutation to one of `user`'s providers. */
export function applyRankMutation(userId: string, id: string, body: unknown): RankMutationResult {
  const request = parseRankMutation(body);
  const provider =
    request.action === "set-rank"
      ? setProviderRank(userId, id, request.rank ?? 0)
      : moveProviderRank(userId, id, request.action === "move-up" ? "up" : "down");
  const row = providerRow(provider, { saved: true });
  return { provider: row, rank: row.rank };
}

/** Apply a validated billing/free-flag mutation to one of `user`'s providers. */
export function applyBillingMutation(userId: string, id: string, body: unknown): ProviderRow {
  const patch = parseBillingMutation(body);
  const provider = setProviderBilling(userId, id, patch);
  return providerRow(provider, { saved: true });
}

/** Apply a billing/free-flag mutation and shape the API response. */
export function runProviderBillingMutation(
  user: string,
  id: string,
  body: unknown
): MutationResponse {
  let patch: ProviderBillingPatch | null = null;
  try {
    patch = parseBillingMutation(body);
    const provider = applyBillingMutation(user, id, body);
    if (user) {
      recordAudit({ user, action: "provider.billing", target: id, result: "success" });
    }
    return { status: 200, body: { ok: true, provider } };
  } catch (err) {
    if (user && patch) {
      recordAudit({ user, action: "provider.billing", target: id, result: "failure" });
    }
    return failure(err);
  }
}

/** Apply a rank/reorder mutation and shape the API response. */
export function runProviderRankMutation(
  user: string,
  id: string,
  body: unknown
): MutationResponse {
  let request: RankMutationRequest | null = null;
  try {
    request = parseRankMutation(body);
    const result = applyRankMutation(user, id, body);
    if (user) {
      recordAudit({ user, action: "provider.rank", target: id, result: "success" });
    }
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    if (user && request) {
      recordAudit({ user, action: "provider.rank", target: id, result: "failure" });
    }
    return failure(err);
  }
}

/** Remove one of `user`'s saved providers and shape the response. */
export function runProviderRemoval(user: string, id: string): MutationResponse {
  try {
    const removed = removeProvider(user, id);
    if (user) {
      recordAudit({ user, action: "provider.delete", target: id, result: "success" });
    }
    return { status: 200, body: { ok: true, removed: true, id: removed.id } };
  } catch (err) {
    if (user) {
      recordAudit({ user, action: "provider.delete", target: id, result: "failure" });
    }
    return failure(err);
  }
}
