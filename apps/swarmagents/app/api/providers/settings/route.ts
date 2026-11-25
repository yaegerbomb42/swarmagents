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
  alwaysOn247For,
  KEY_SELECTION_MODES,
  MAX_SEARCH_KEY_CHARS,
  MAX_SYSTEM_BUDGET_TOKENS,
  MIN_SYSTEM_BUDGET_TOKENS,
  VM_PERSISTENCE_MODES,
  atlasEnabledForUser,
  autoCondenseLogsFor,
  codebaseContextInjectionEnabled,
  contextPackerModeFor,
  isKeySelectionMode,
  isVmPersistenceMode,
  keySelectionModeFor,
  parseWebSearchConfig,
  readUserSettings,
  tokenEfficiencyFor,
  updateUserSettings,
  vmPersistenceModeFor,
} from "@/lib/providers/settings";
import type { TokenEfficiencySettings, UserSettings } from "@/lib/providers/settings";
import type { DecisionBrainSettingsInput } from "@/lib/harness/decision-brain/settings";
import { isSearchBackend, type WebSearchConfig } from "@/lib/web/search";

export const dynamic = "force-dynamic";


/** Public view of settings: never echo web-search API keys. */
function publicSettings(settings: UserSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...settings,
    injectCodebaseContext: codebaseContextInjectionEnabled(settings),
    enableAtlas: atlasEnabledForUser(settings),
    tokenEfficiency: {
      ...tokenEfficiencyFor(settings),
      contextPacker: contextPackerModeFor(settings),
      autoCondenseLogs: autoCondenseLogsFor(settings),
    },
    keySelectionMode: keySelectionModeFor(settings),
    vmPersistenceMode: vmPersistenceModeFor(settings),
    alwaysOn247: alwaysOn247For(settings),
  };
  if (settings.webSearch) {
    out.webSearch = {
      backend: settings.webSearch.backend,
      ...(settings.webSearch.searxngUrl ? { searxngUrl: settings.webSearch.searxngUrl } : {}),
      ...(settings.webSearch.apiKey ? { apiKeyMask: `••••${settings.webSearch.apiKey.slice(-4)}` } : {}),
    };
  }
  return out;
}

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
  return NextResponse.json(publicSettings(settings), { headers: NO_STORE });
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
  if ("enableAtlas" in input) {
    if (typeof input.enableAtlas !== "boolean") {
      return NextResponse.json({ error: "enableAtlas must be a boolean." }, { status: 400 });
    }
    patch.enableAtlas = input.enableAtlas;
  }
  if ("allowPaidProviders" in input) {
    if (typeof input.allowPaidProviders !== "boolean") {
      return NextResponse.json({ error: "allowPaidProviders must be a boolean." }, { status: 400 });
    }
    patch.allowPaidProviders = input.allowPaidProviders;
  }
  if ("keySelectionMode" in input) {
    if (!isKeySelectionMode(input.keySelectionMode)) {
      return NextResponse.json(
        { error: `keySelectionMode must be one of: ${KEY_SELECTION_MODES.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.keySelectionMode = input.keySelectionMode;
  }
  if ("vmPersistenceMode" in input) {
    if (!isVmPersistenceMode(input.vmPersistenceMode)) {
      return NextResponse.json(
        { error: `vmPersistenceMode must be one of: ${VM_PERSISTENCE_MODES.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.vmPersistenceMode = input.vmPersistenceMode;
  }
  if ("alwaysOn247" in input) {
    if (typeof input.alwaysOn247 !== "boolean") {
      return NextResponse.json({ error: "alwaysOn247 must be a boolean." }, { status: 400 });
    }
    patch.alwaysOn247 = input.alwaysOn247;
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
  if ("tokenEfficiency" in input) {
    const value = input.tokenEfficiency;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return NextResponse.json({ error: "tokenEfficiency must be an object." }, { status: 400 });
    }
    const te = value as Record<string, unknown>;
    // Merge over the stored values so a partial update (e.g. flipping one
    // toggle) cannot wipe a budget set through the API earlier.
    const nextTe: TokenEfficiencySettings = { ...(readUserSettings(owner).tokenEfficiency ?? {}) };
    for (const field of ["packSystemPrompt", "cacheFriendlyOrder", "autoCondenseLogs"] as const) {
      if (!(field in te)) continue;
      if (typeof te[field] !== "boolean") {
        return NextResponse.json({ error: `tokenEfficiency.${field} must be a boolean.` }, { status: 400 });
      }
      nextTe[field] = te[field] as boolean;
    }
    if ("contextPacker" in te) {
      if (te.contextPacker !== "claude-code" && te.contextPacker !== "l1") {
        return NextResponse.json(
          { error: "tokenEfficiency.contextPacker must be 'claude-code' or 'l1'." },
          { status: 400 },
        );
      }
      nextTe.contextPacker = te.contextPacker;
    }
    if ("systemBudgetTokens" in te) {
      const budget = te.systemBudgetTokens;
      if (
        typeof budget !== "number" ||
        !Number.isFinite(budget) ||
        budget < MIN_SYSTEM_BUDGET_TOKENS ||
        budget > MAX_SYSTEM_BUDGET_TOKENS
      ) {
        return NextResponse.json(
          {
            error: `tokenEfficiency.systemBudgetTokens must be a number between ${MIN_SYSTEM_BUDGET_TOKENS} and ${MAX_SYSTEM_BUDGET_TOKENS}.`,
          },
          { status: 400 },
        );
      }
      nextTe.systemBudgetTokens = Math.floor(budget);
    }
    patch.tokenEfficiency = nextTe;
  }
  if ("race" in input) {
    const race = input.race;
    if (!race || typeof race !== "object" || Array.isArray(race)) {
      return NextResponse.json({ error: "race must be an object." }, { status: 400 });
    }
    const r = race as Record<string, unknown>;
    if (typeof r.enabled !== "boolean") {
      return NextResponse.json({ error: "race.enabled must be a boolean." }, { status: 400 });
    }
    const racePatch: NonNullable<UserSettings["race"]> = { enabled: r.enabled };
    for (const [field, max] of [["maxParallel", 8], ["keysPerProvider", 5]] as const) {
      if (!(field in r)) continue;
      const value = r[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > max) {
        return NextResponse.json(
          { error: `race.${field} must be a number between 1 and ${max}.` },
          { status: 400 },
        );
      }
      racePatch[field] = Math.floor(value);
    }
    patch.race = racePatch;
  }

  if ("webSearch" in input) {
    const value = input.webSearch;
    if (value === null) {
      // Explicit null clears the search config.
      patch.webSearch = undefined;
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return NextResponse.json({ error: "webSearch must be an object or null." }, { status: 400 });
      }
      const ws = value as Record<string, unknown>;
      const current = readUserSettings(owner).webSearch;
      // Merge sub-fields against the stored config: an absent apiKey keeps
      // the stored key (the GET only ever returns a mask), an empty string
      // clears it.
      const next: WebSearchConfig = {
        backend: current?.backend ?? "brave",
        ...(current?.apiKey ? { apiKey: current.apiKey } : {}),
        ...(current?.searxngUrl ? { searxngUrl: current.searxngUrl } : {}),
      };
      if ("backend" in ws) {
        if (!isSearchBackend(ws.backend)) {
          return NextResponse.json(
            { error: "webSearch.backend must be one of brave, tavily, exa, searxng." },
            { status: 400 },
          );
        }
        next.backend = ws.backend;
      }
      if ("apiKey" in ws) {
        if (typeof ws.apiKey !== "string" || ws.apiKey.length > MAX_SEARCH_KEY_CHARS) {
          return NextResponse.json({ error: "webSearch.apiKey must be a string." }, { status: 400 });
        }
        const key = ws.apiKey.trim();
        if (key) next.apiKey = key;
        else delete next.apiKey;
      }
      if ("searxngUrl" in ws) {
        if (ws.searxngUrl === null || ws.searxngUrl === "") {
          delete next.searxngUrl;
        } else {
          if (typeof ws.searxngUrl !== "string") {
            return NextResponse.json({ error: "webSearch.searxngUrl must be an http(s) URL." }, { status: 400 });
          }
          let url: URL;
          try {
            url = new URL(ws.searxngUrl.trim());
          } catch {
            return NextResponse.json({ error: "webSearch.searxngUrl is not a valid URL." }, { status: 400 });
          }
          if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
            return NextResponse.json(
              { error: "webSearch.searxngUrl must use http(s) and carry no credentials." },
              { status: 400 },
            );
          }
          // The instance URL is fetched server-side at search time: validate
          // it like every other provider URL so it cannot point the server
          // at internal addresses. The search layer re-checks (SSRF guard)
          // on every call as well.
          const normalized = ws.searxngUrl.trim().replace(/\/+$/, "");
          const safe = await assertResolvableProviderBaseUrl(normalized);
          if (!safe.ok) {
            return NextResponse.json({ error: safe.error }, { status: 400 });
          }
          next.searxngUrl = normalized;
        }
      }
      const parsed = parseWebSearchConfig(next);
      if (!parsed) {
        return NextResponse.json({ error: "webSearch config is invalid." }, { status: 400 });
      }
      patch.webSearch = parsed;
    }
  }

  if ("decisionBrain" in input) {
    const value = input.decisionBrain;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return NextResponse.json({ error: "decisionBrain must be an object." }, { status: 400 });
    }
    const brain = value as Record<string, unknown>;
    const brainPatch: DecisionBrainSettingsInput = {};
    if ("enabled" in brain) {
      if (typeof brain.enabled !== "boolean") {
        return NextResponse.json({ error: "decisionBrain.enabled must be a boolean." }, { status: 400 });
      }
      brainPatch.enabled = brain.enabled;
    }
    if ("confidenceThreshold" in brain) {
      const v = brain.confidenceThreshold;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return NextResponse.json(
          { error: "decisionBrain.confidenceThreshold must be a number between 0 and 1." },
          { status: 400 }
        );
      }
      brainPatch.confidenceThreshold = v;
    }
    if ("hookTimeoutMs" in brain) {
      const v = brain.hookTimeoutMs;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return NextResponse.json(
          { error: "decisionBrain.hookTimeoutMs must be a positive number." },
          { status: 400 }
        );
      }
      brainPatch.hookTimeoutMs = v;
    }
    if ("maxTurns" in brain) {
      const v = brain.maxTurns;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return NextResponse.json(
          { error: "decisionBrain.maxTurns must be a positive number." },
          { status: 400 }
        );
      }
      brainPatch.maxTurns = Math.floor(v);
    }
    // Merge over the stored brain settings so toggling `enabled` from the UI
    // does not wipe thresholds a user set through the API.
    patch.decisionBrain = { ...readUserSettings(owner).decisionBrain, ...brainPatch };
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No supported settings were provided." }, { status: 400 });
  }
  const next = updateUserSettings(owner, patch);
  return NextResponse.json(publicSettings(next), { status: 200, headers: NO_STORE });
}
