/**
 * Per-user LLM routing settings (GET/PUT /api/providers/settings).
 *
 * "Prefer free providers" (default on): the LLM router uses an eligible
 * provider marked free (isFree) before any paid one, with the user's rank as
 * the tiebreaker. Optional paid-provider controls: allowPaidProviders
 * (default true) and perRunBudgetUsd / perDayBudgetUsd caps (default none).
 */

import { NextResponse, type NextRequest } from "next/server";
import { providerOwner } from "@/lib/providers/owner";
import { assertResolvableProviderBaseUrl } from "@/lib/providers/url-safety";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import {
  codebaseContextInjectionEnabled,
  readUserSettings,
  updateUserSettings,
} from "@/lib/providers/settings";
import type { UserSettings } from "@/lib/providers/settings";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export function GET(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const settings = readUserSettings(owner);
  // The codebase context is on unless it was turned off: report the effective
  // value so the toggle always shows the truth.
  return NextResponse.json(
    { ...settings, injectCodebaseContext: codebaseContextInjectionEnabled(settings) },
    { headers: NO_STORE },
  );
}

export async function PUT(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const patch: Partial<UserSettings> = {};
  if ("preferFreeProviders" in input) {
    if (typeof input.preferFreeProviders !== "boolean") {
      return NextResponse.json({ error: "preferFreeProviders must be a boolean." }, { status: 400 });
    }
    patch.preferFreeProviders = input.preferFreeProviders;
  }
  if ("injectCodebaseContext" in input) {
    if (typeof input.injectCodebaseContext !== "boolean") {
      return NextResponse.json({ error: "injectCodebaseContext must be a boolean." }, { status: 400 });
    }
    patch.injectCodebaseContext = input.injectCodebaseContext;
  }
  if ("allowPaidProviders" in input) {
    if (typeof input.allowPaidProviders !== "boolean") {
      return NextResponse.json({ error: "allowPaidProviders must be a boolean." }, { status: 400 });
    }
    patch.allowPaidProviders = input.allowPaidProviders;
  }
  for (const field of ["perRunBudgetUsd", "perDayBudgetUsd"] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return NextResponse.json({ error: `${field} must be a non-negative number or null.` }, { status: 400 });
    }
    patch[field] = value as number | null;
  }
  if ("ollamaBaseUrl" in input) {
    const value = input.ollamaBaseUrl;
    if (typeof value !== "string" || value.trim() === "") {
      return NextResponse.json({ error: "ollamaBaseUrl must be an http(s) URL." }, { status: 400 });
    }
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return NextResponse.json({ error: "ollamaBaseUrl is not a valid URL." }, { status: 400 });
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return NextResponse.json(
        { error: "ollamaBaseUrl must use http(s) and carry no credentials." },
        { status: 400 }
      );
    }
    // The stored value is not read by any Ollama call today (Ollama uses the
    // validated provider config or the 127.0.0.1:11434 default), but validate
    // it like every other provider URL now so the setting cannot smuggle a
    // metadata/internal address in before it is wired up. Loopback stays
    // allowed in local mode, per the URL-safety helper.
    const normalized = value.trim().replace(/\/+$/, "");
    const safe = await assertResolvableProviderBaseUrl(normalized);
    if (!safe.ok) {
      return NextResponse.json({ error: safe.error }, { status: 400 });
    }
    patch.ollamaBaseUrl = normalized;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No supported settings were provided." }, { status: 400 });
  }
  const next = updateUserSettings(owner, patch);
  return NextResponse.json(
    { ...next, injectCodebaseContext: codebaseContextInjectionEnabled(next) },
    { status: 200, headers: NO_STORE },
  );
}
