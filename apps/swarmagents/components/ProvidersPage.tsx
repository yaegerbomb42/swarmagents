"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Activity, ArrowLeft, BookOpen, ChevronDown, ChevronUp, DollarSign, KeyRound, Loader2, Plug, Plus, RotateCw, Search, Trash2, X } from "lucide-react";
import { runModeLabel } from "@/lib/client/runModeLabel";
import { PROVIDER_CATALOG, canonicalProviderId, catalogEntry, providerHue } from "../lib/providers/catalog";
import type { CatalogApiStyle, ProviderCatalogEntry } from "../lib/providers/catalog";

interface KeySlot {
  index: number;
  mask: string;
}

interface CatalogRow extends ProviderCatalogEntry {
  connected: boolean;
  keyCount: number;
  /** Lower ranks are tried first by the router. */
  rank: number;
  /** True when the provider (and its keys) live in the server-side config file. */
  saved: boolean;
  keySlots: KeySlot[];
}

interface ConfiguredRow {
  id: string;
  label: string;
  model: string;
  enabled: boolean;
  models: string[];
  keyCount: number;
  rank: number;
  saved: boolean;
  keySlots: KeySlot[];
}

interface ProvidersData {
  catalog: CatalogRow[];
  providers: ConfiguredRow[];
}

interface AddDraft {
  entry: ProviderCatalogEntry;
  /** Provider id sent to the API; editable for the custom endpoint. */
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  saving: boolean;
  error: string;
}

interface KeyDraft {
  entry: ProviderCatalogEntry;
  /** "add" appends a key, "rotate" replaces the key in the selected slot. */
  mode: "add" | "rotate";
  /** Slot the new key replaces (rotate mode). */
  slot: number;
  apiKey: string;
  saving: boolean;
  error: string;
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Filter chips above the grid: every wire-format style in the catalog. */
const STYLE_CHIPS: ReadonlyArray<{ value: "all" | CatalogApiStyle; label: string }> = [
  { value: "all", label: "All" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "gemini", label: "Gemini" },
  { value: "custom", label: "Custom" },
];

/**
 * Minimal modal shell: dialog semantics, Escape-to-close and a Tab focus trap.
 * There is no shared Modal primitive in the app yet, so these two provider
 * modals carry the behavior themselves.
 */
function Dialog({
  labelledBy,
  onClose,
  className,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={className}
      >
        {children}
      </div>
    </div>
  );
}

export function ProvidersPage() {
  const [data, setData] = useState<ProvidersData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [styleFilter, setStyleFilter] = useState<"all" | CatalogApiStyle>("all");
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [keyDraft, setKeyDraft] = useState<KeyDraft | null>(null);
  const [saved, setSaved] = useState("");
  /** Provider id whose removal is waiting for a confirmation click. */
  const [confirmRemove, setConfirmRemove] = useState("");
  /** Provider ids with an in-flight mutation (a set so actions can overlap). */
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  /** Per-provider test-connection result (testing flag, ok/latency/error/runMode). */
  const [testState, setTestState] = useState<
    Record<
      string,
      {
        testing: boolean;
        ok?: boolean;
        latencyMs?: number;
        error?: string;
        runMode?: {
          mode: string;
          label: string;
          reason: string;
          capabilities?: { vision?: boolean; tools?: boolean };
        };
      }
    >
  >({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ProvidersData;
      setData({ catalog: body.catalog, providers: body.providers });
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectedById = useMemo(() => {
    const map = new Map<string, CatalogRow>();
    for (const row of data?.catalog ?? []) {
      if (row.connected) map.set(row.id, row);
    }
    return map;
  }, [data]);

  /** Providers whose keys live in the server-side config file (manageable). */
  const savedById = useMemo(() => {
    const map = new Map<string, CatalogRow>();
    for (const row of data?.catalog ?? []) {
      if (row.saved) map.set(row.id, row);
    }
    return map;
  }, [data]);

  /** The key slots of a provider, as last-4 masks (never key material). */
  const slotsFor = useCallback(
    (id: string): KeySlot[] =>
      (data?.catalog ?? []).find((row) => row.id === id)?.keySlots ?? [],
    [data]
  );

  /** Configured providers in router order, plus a lookup for rank badges. */
  const rankedProviders = useMemo(
    () => [...(data?.providers ?? [])].sort((a, b) => a.rank - b.rank),
    [data]
  );
  const rankById = useMemo(
    () => new Map(rankedProviders.map((row) => [row.id, row.rank])),
    [rankedProviders]
  );

  /**
   * Saved providers only, in router order. These are the entries the reorder
   * endpoints can actually mutate; env-only providers have no saved row.
   */
  const reorderableProviders = useMemo(
    () => [...(data?.providers ?? [])].filter((row) => row.saved).sort((a, b) => a.rank - b.rank),
    [data]
  );
  const reorderIndexById = useMemo(
    () => new Map(reorderableProviders.map((row, index) => [row.id, index])),
    [reorderableProviders]
  );

  /** The catch-all catalog entry, looked up by id rather than by position. */
  const customEntry = useMemo(() => catalogEntry("custom"), []);

  const setProviderBusy = useCallback((id: string, value: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** Catalog rows matching the search box and the active API-style chip. */
  const visibleCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    const catalogOrder = new Map(PROVIDER_CATALOG.map((entry, index) => [entry.id, index]));
    return (data?.catalog ?? [])
      .filter((entry) => {
        if (styleFilter !== "all" && entry.apiStyle !== styleFilter) return false;
        if (q === "") return true;
        return (
          entry.name.toLowerCase().includes(q) ||
          entry.shortDescription.toLowerCase().includes(q) ||
          entry.apiStyle.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const ar = rankById.get(a.id);
        const br = rankById.get(b.id);
        // Configured providers come first in router order; unconfigured
        // providers keep the catalog's curated order.
        if (ar === undefined && br === undefined) {
          return (catalogOrder.get(a.id) ?? 0) - (catalogOrder.get(b.id) ?? 0);
        }
        if (ar === undefined) return 1;
        if (br === undefined) return -1;
        return ar - br || (catalogOrder.get(a.id) ?? 0) - (catalogOrder.get(b.id) ?? 0);
      });
  }, [data, query, styleFilter, rankById]);

  const openAdd = (entry: ProviderCatalogEntry) => {
    setSaved("");
    setDraft({
      entry,
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl ?? "",
      model: entry.models?.default ?? "",
      apiKey: "",
      saving: false,
      error: "",
    });
  };

  const closeAdd = () => setDraft(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const id = canonicalProviderId(draft.id);
    if (id === "") {
      setDraft({ ...draft, error: "Enter a provider id (a-z, 0-9, dashes)." });
      return;
    }
    const name = draft.name.trim();
    setDraft({ ...draft, saving: true, error: "" });
    try {
      const model = draft.model.trim();
      const models = model !== "" ? [model] : draft.entry.models?.popular ?? [];
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          name: name !== "" ? name : undefined,
          apiStyle: draft.entry.apiStyle,
          baseUrl: draft.baseUrl.trim() !== "" ? draft.baseUrl.trim() : undefined,
          models: models.length > 0 ? models : undefined,
          apiKey: draft.apiKey.trim() !== "" ? draft.apiKey.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setSaved(`${name || draft.entry.name} connected — key stored server-side.`);
      setDraft(null);
      await refresh();
    } catch (err) {
      setDraft({
        ...draft,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openKey = (entry: ProviderCatalogEntry, mode: "add" | "rotate", slot = 0) => {
    setSaved("");
    setKeyDraft({ entry, mode, slot, apiKey: "", saving: false, error: "" });
  };

  const closeKey = () => setKeyDraft(null);

  /** PATCH a single key slot: add, rotate or remove. */
  const patchKey = async (entry: ProviderCatalogEntry, body: Record<string, unknown>) => {
    setProviderBusy(entry.id, true);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } finally {
      setProviderBusy(entry.id, false);
    }
  };

  const submitKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!keyDraft) return;
    const apiKey = keyDraft.apiKey.trim();
    if (apiKey === "") {
      setKeyDraft({ ...keyDraft, error: "Enter the new API key." });
      return;
    }
    setKeyDraft({ ...keyDraft, saving: true, error: "" });
    try {
      await patchKey(
        keyDraft.entry,
        keyDraft.mode === "add"
          ? { action: "add-key", apiKey }
          : { action: "rotate-key", index: keyDraft.slot, apiKey }
      );
      setSaved(
        keyDraft.mode === "add"
          ? `${keyDraft.entry.name} — key added.`
          : `${keyDraft.entry.name} — key rotated.`
      );
      setKeyDraft(null);
    } catch (err) {
      setKeyDraft({
        ...keyDraft,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const removeKey = async (entry: ProviderCatalogEntry, index: number) => {
    try {
      await patchKey(entry, { action: "remove-key", index });
      setSaved(`${entry.name} — key removed.`);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  /** DELETE the provider and every key it holds. */
  const removeProvider = async (entry: ProviderCatalogEntry) => {
    setProviderBusy(entry.id, true);
    setConfirmRemove("");
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      setSaved(`${entry.name} removed.`);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderBusy(entry.id, false);
    }
  };

  /** Move a provider one slot up or down in the router's rank order. */
  const reorderProvider = async (entry: ProviderCatalogEntry, direction: "up" | "down") => {
    setProviderBusy(entry.id, true);
    setLoadError("");
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: direction === "up" ? "move-up" : "move-down" }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderBusy(entry.id, false);
    }
  };

  /** Run a live test-connection probe for one provider. */
  const testConnection = async (entry: ProviderCatalogEntry) => {
    setTestState((prev) => ({ ...prev, [entry.id]: { testing: true } }));
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(entry.id)}/test`, {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        test: { ok: boolean; latencyMs: number; error?: string };
        runMode?: {
          mode: string;
          label: string;
          reason: string;
          capabilities?: { vision?: boolean; tools?: boolean };
        };
      };
      setTestState((prev) => ({
        ...prev,
        [entry.id]: {
          testing: false,
          ok: body.test.ok,
          latencyMs: body.test.latencyMs,
          error: body.test.error,
          runMode: body.runMode,
        },
      }));
    } catch (err) {
      setTestState((prev) => ({
        ...prev,
        [entry.id]: { testing: false, ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const linkFor = (entry: ProviderCatalogEntry, kind: "key" | "docs" | "pricing"): string | undefined => {
    if (kind === "key") return entry.links.apiKeys ?? entry.links.console ?? entry.links.signup;
    if (kind === "docs") return entry.links.docs;
    return entry.links.pricing;
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#07070a] text-white antialiased">
      {/* Ambient background glow, matching the app shell */}
      <div className="pointer-events-none fixed inset-0">
        <div className="blob left-[10%] top-[15%] h-[420px] w-[420px] bg-[#5b5bf7]" />
        <div className="blob bottom-[5%] right-[8%] h-[480px] w-[480px] bg-[#0ea5a4]" style={{ animationDelay: "-6s" }} />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,#07070a_75%)]" />
      </div>

      <nav
        aria-label="Workspace navigation"
        className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2.5 px-6 pt-6"
      >
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/75 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Workspace
        </Link>
        <p className="mr-2 font-mono text-sm font-semibold tracking-tight">
          swarmagents<span className="text-cyan-400">.codes</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href="/connectors"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <Plug className="h-3 w-3" aria-hidden />
            Connectors
          </Link>
          <Link
            href="/providers"
            aria-current="page"
            className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1 text-xs font-medium text-cyan-200"
          >
            Providers
          </Link>
          <Link
            href="/library"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Library
          </Link>
        </div>
      </nav>

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-10 pt-8">
        <div className="mb-2 text-2xl font-semibold tracking-tight">Providers</div>
        <p className="mb-6 max-w-2xl text-sm text-white/50">
          Pick a provider, paste an API key — this joins the server-side pool used by the
          router and health checks. Keys never leave the server.
        </p>

        <div className="mb-6 flex flex-col gap-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers…"
              aria-label="Search providers"
              spellCheck={false}
              className="w-full rounded-full bg-white/[0.04] py-2 pl-9 pr-3 text-sm text-white/85 ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-cyan-400/40"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {STYLE_CHIPS.map((chip) => {
              const active = styleFilter === chip.value;
              return (
                <button
                  key={chip.value}
                  type="button"
                  onClick={() => setStyleFilter(chip.value)}
                  aria-pressed={active}
                  className={
                    active
                      ? "rounded-full bg-cyan-400/15 px-3 py-1 text-xs font-medium text-cyan-300 ring-1 ring-cyan-400/40"
                      : "rounded-full bg-white/[0.04] px-3 py-1 text-xs text-white/55 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-white/80"
                  }
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {saved && (
          <div className="mb-6 flex items-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
            <KeyRound className="h-4 w-4" />
            {saved}
          </div>
        )}
        {loadError && (
          <div className="mb-6 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">
            Could not load providers: {loadError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleCatalog.map((entry) => {
            const hue = providerHue(entry.id);
            const row = connectedById.get(entry.id);
            const savedRow = savedById.get(entry.id);
            const connected = row !== undefined;
            const rank = rankById.get(entry.id);
            const reorderIndex = reorderIndexById.get(entry.id);
            const keyLink = linkFor(entry, "key");
            const docsLink = linkFor(entry, "docs");
            const pricingLink = linkFor(entry, "pricing");
            return (
              <div
                key={entry.id}
                className="flex flex-col rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/10 transition hover:bg-white/[0.07] hover:ring-white/20"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-semibold"
                    style={{
                      background: `hsl(${hue} 70% 60% / .14)`,
                      color: `hsl(${hue} 85% 75%)`,
                    }}
                  >
                    {initials(entry.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white/90">{entry.name}</div>
                    <div className="mt-0.5 truncate text-xs text-white/45">
                      {entry.shortDescription}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {keyLink && (
                      <a
                        href={keyLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Get API key"
                        aria-label={`Get API key for ${entry.name}`}
                        className="rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {docsLink && (
                      <a
                        href={docsLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Documentation"
                        aria-label={`Documentation for ${entry.name}`}
                        className="rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {pricingLink && (
                      <a
                        href={pricingLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Pricing"
                        aria-label={`Pricing for ${entry.name}`}
                        className="rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                      >
                        <DollarSign className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-1.5 text-[11px] text-white/35">
                  <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono capitalize">
                    {entry.apiStyle}
                  </span>
                  {rank !== undefined && (
                    <span
                      className="rounded-full bg-white/5 px-2 py-0.5 font-mono"
                      title="Router rank: lower runs first"
                    >
                      rank {rank}
                    </span>
                  )}
                  {entry.isLocal && (
                    <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono">local</span>
                  )}
                  <span className="truncate rounded-full bg-white/5 px-2 py-0.5 font-mono">
                    {entry.envVar}
                  </span>
                </div>

                {savedRow && (
                  <div className="mt-3 space-y-1.5">
                    {savedRow.keySlots.map((slot) => (
                      <div
                        key={slot.index}
                        className="flex items-center justify-between gap-2 rounded-xl bg-black/25 px-3 py-1.5"
                      >
                        <span className="font-mono text-[11px] tracking-wide text-white/60">
                          {slot.mask}
                        </span>
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            title="Rotate this key"
                            aria-label={`Rotate key ${slot.index + 1} of ${entry.name}`}
                            onClick={() => openKey(entry, "rotate", slot.index)}
                            className="rounded-full p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
                          >
                            <RotateCw className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            title="Remove this key"
                            aria-label={`Remove key ${slot.index + 1} of ${entry.name}`}
                            disabled={busy.has(entry.id)}
                            onClick={() => removeKey(entry, slot.index)}
                            className="rounded-full p-1 text-white/40 transition hover:bg-white/10 hover:text-red-300 disabled:opacity-40"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      </div>
                    ))}
                    {savedRow.keySlots.length === 0 && (
                      <div className="rounded-xl bg-black/25 px-3 py-1.5 text-[11px] text-white/40">
                        No keys stored — add one to put this provider back in rotation.
                      </div>
                    )}
                  </div>
                )}

                {connected && !savedRow && (
                  <div className="mt-3 rounded-xl bg-black/25 px-3 py-1.5 text-[11px] text-white/40">
                    Keys come from the environment — save the provider here to manage them.
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  {connected ? (
                    <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 ring-1 ring-emerald-400/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      Connected · {row?.keyCount ?? 0} key{(row?.keyCount ?? 0) === 1 ? "" : "s"}
                    </span>
                  ) : savedRow ? (
                    <span className="rounded-full bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/20">
                      No keys
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1.5 text-xs text-white/45 ring-1 ring-white/10">
                      <span className="h-1.5 w-1.5 rounded-full bg-white/30" />
                      Not connected
                    </span>
                  )}
                  {!connected && !savedRow && (
                    <button
                      onClick={() => openAdd(entry)}
                      className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15 hover:text-white"
                    >
                      <Plus className="h-3 w-3" />
                      Add
                    </button>
                  )}
                </div>

                {savedRow && reorderIndex !== undefined && reorderableProviders.length > 1 && (
                  <div className="mt-3 flex items-center gap-1">
                    <span className="mr-1 text-[11px] text-white/35">Order</span>
                    <button
                      type="button"
                      title="Move earlier in the fallback order"
                      aria-label={`Move ${entry.name} up`}
                      disabled={reorderIndex <= 0 || busy.has(entry.id)}
                      onClick={() => void reorderProvider(entry, "up")}
                      className="rounded-full p-1 text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Move later in the fallback order"
                      aria-label={`Move ${entry.name} down`}
                      disabled={reorderIndex >= reorderableProviders.length - 1 || busy.has(entry.id)}
                      onClick={() => void reorderProvider(entry, "down")}
                      className="rounded-full p-1 text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {savedRow && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openKey(entry, "add")}
                      className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15 hover:text-white"
                    >
                      <Plus className="h-3 w-3" />
                      Add key
                    </button>
                    <button
                      type="button"
                      disabled={savedRow.keySlots.length === 0}
                      onClick={() => openKey(entry, "rotate", savedRow.keySlots[0]?.index ?? 0)}
                      className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15 hover:text-white disabled:opacity-40"
                    >
                      <RotateCw className="h-3 w-3" />
                      Rotate
                    </button>
                    {confirmRemove === entry.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => removeProvider(entry)}
                          disabled={busy.has(entry.id)}
                          className="flex items-center gap-1.5 rounded-full bg-red-400/15 px-3 py-1.5 text-xs text-red-200 ring-1 ring-red-400/30 transition hover:bg-red-400/25 disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" />
                          Confirm remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove("")}
                          className="rounded-full px-3 py-1.5 text-xs text-white/50 transition hover:text-white"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(entry.id)}
                        className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs text-white/60 transition hover:bg-red-400/15 hover:text-red-200"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove
                      </button>
                    )}
                  </div>
                )}

                {(connected || (savedRow && savedRow.keySlots.length > 0)) && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void testConnection(entry)}
                      disabled={testState[entry.id]?.testing}
                      className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15 hover:text-white disabled:opacity-50"
                    >
                      {testState[entry.id]?.testing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Activity className="h-3 w-3" />
                      )}
                      {testState[entry.id]?.testing ? "Testing…" : "Test connection"}
                    </button>
                    {testState[entry.id]?.testing === false && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`flex items-center gap-1.5 text-[11px] ${
                            testState[entry.id]?.ok ? "text-emerald-300" : "text-red-300"
                          }`}
                        >
                          {testState[entry.id]?.ok
                            ? `OK · ${testState[entry.id]?.latencyMs}ms`
                            : `Failed · ${testState[entry.id]?.error ?? "unknown error"}`}
                        </span>
                        {testState[entry.id]?.ok && testState[entry.id]?.runMode && (
                          <span
                            title={testState[entry.id]?.runMode?.reason}
                            data-testid={`provider-runmode-${entry.id}`}
                            className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/80"
                          >
                            {runModeLabel(testState[entry.id]?.runMode)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {data && visibleCatalog.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed border-white/15 px-6 py-10 text-center text-sm text-white/45">
              No providers match your search.
            </div>
          )}
        </div>

        <div className="mt-10">
          {customEntry && (
            <button
              onClick={() => openAdd(customEntry)}
              className="flex items-center gap-2 rounded-2xl border border-dashed border-white/15 px-5 py-4 text-sm text-white/60 transition hover:border-white/30 hover:text-white"
            >
              <Plus className="h-4 w-4" />
              Add your own OpenAI-compatible endpoint
            </button>
          )}
        </div>
      </div>

      {draft && (
        <Dialog
          labelledBy="add-provider-title"
          onClose={closeAdd}
          className="relative w-full max-w-md rounded-3xl bg-[#0d0d12] p-6 ring-1 ring-white/10"
        >
          <form onSubmit={submit}>
            <div className="mb-4 flex items-center justify-between">
              <div id="add-provider-title" className="text-base font-medium text-white/90">
                {draft.name || draft.entry.name}
              </div>
              <button type="button" onClick={closeAdd} className="rounded-full p-1.5 text-white/50 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            {draft.entry.id === "custom" && (
              <>
                <label className="mb-3 block">
                  <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                    Name
                  </span>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="My endpoint"
                    spellCheck={false}
                    className="w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
                  />
                </label>

                <label className="mb-3 block">
                  <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                    Provider id
                  </span>
                  <input
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    placeholder="my-endpoint"
                    spellCheck={false}
                    className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
                  />
                </label>
              </>
            )}

            <label className="mb-3 block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                Base URL
              </span>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
              />
            </label>

            <label className="mb-3 block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                Model
              </span>
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="default model"
                spellCheck={false}
                list="provider-models"
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
              />
              <datalist id="provider-models">
                {(draft.entry.models?.popular ?? []).map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                API key {draft.entry.authHeader === "none" && <span className="normal-case text-white/25">(not required locally)</span>}
              </span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder={`${draft.entry.standardEnvVar ?? draft.entry.envVar} · e.g. sk-…`}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
              />
            </label>

            {draft.error && (
              <div className="mb-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
                {draft.error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeAdd}
                className="rounded-full px-4 py-2 text-xs text-white/50 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={draft.saving}
                className="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium text-black transition hover:bg-white/85 disabled:opacity-50"
              >
                {draft.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                Save provider
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {keyDraft && (
        <Dialog
          labelledBy="key-provider-title"
          onClose={closeKey}
          className="relative w-full max-w-md rounded-3xl bg-[#0d0d12] p-6 ring-1 ring-white/10"
        >
          <form onSubmit={submitKey}>
            <div className="mb-4 flex items-center justify-between">
              <div id="key-provider-title" className="text-base font-medium text-white/90">
                {keyDraft.mode === "add" ? "Add key" : "Rotate key"} · {keyDraft.entry.name}
              </div>
              <button type="button" onClick={closeKey} className="rounded-full p-1.5 text-white/50 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            {keyDraft.mode === "rotate" && (
              <label className="mb-3 block">
                <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                  Key slot
                </span>
                <select
                  value={keyDraft.slot}
                  onChange={(e) => setKeyDraft({ ...keyDraft, slot: Number(e.target.value) })}
                  className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-white/30"
                >
                  {(slotsFor(keyDraft.entry.id) ?? []).map((slot) => (
                    <option key={slot.index} value={slot.index}>
                      Slot {slot.index + 1} — {slot.mask}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="mb-4 block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">
                {keyDraft.mode === "add" ? "New API key" : "Replacement API key"}
              </span>
              <input
                type="password"
                value={keyDraft.apiKey}
                onChange={(e) => setKeyDraft({ ...keyDraft, apiKey: e.target.value })}
                placeholder={`${keyDraft.entry.standardEnvVar ?? keyDraft.entry.envVar} · e.g. sk-…`}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/30"
              />
            </label>

            <p className="mb-3 text-[11px] leading-relaxed text-white/35">
              The key is stored server-side. The API only ever reports how many keys a provider
              has and their last four characters.
            </p>

            {keyDraft.error && (
              <div className="mb-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
                {keyDraft.error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeKey}
                className="rounded-full px-4 py-2 text-xs text-white/50 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={keyDraft.saving}
                className="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-medium text-black transition hover:bg-white/85 disabled:opacity-50"
              >
                {keyDraft.saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCw className="h-3 w-3" />
                )}
                {keyDraft.mode === "add" ? "Add key" : "Rotate key"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </main>
  );
}
