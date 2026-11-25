"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import type { ConnectorCategory } from "../lib/connectors/categories";
import { CONNECTOR_CATEGORIES } from "../lib/connectors/categories";
import type { ConnectorFieldSpec } from "../lib/connectors/catalog";

interface RegistryServerRow {
  id: string;
  name: string;
  description: string;
  version: string;
  transport: "http" | "stdio" | "unknown";
  url?: string;
  packageManager?: "npx" | "uvx";
  packageName?: string;
}

interface CustomConnectorRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  origin: "user" | "agent" | "public";
  updatedAt: number;
  payload?: {
    transport?: string;
    url?: string;
    command?: string;
    args?: string[];
  };
}

interface ConnectorRow {
  id: string;
  name: string;
  vendor: string;
  category: ConnectorCategory;
  description: string;
  unlocks: string;
  badges: readonly string[];
  isFree?: boolean;
  accent: string;
  docsUrl: string;
  keyHelpUrl?: string;
  providerId?: string;
  libraryConnectorId?: string;
  vaultSecret?: { id: string; kind: string; label: string };
  fields: readonly ConnectorFieldSpec[];
  connected: boolean;
  providerConnected: boolean;
  mcpInstalled: boolean;
  vaultConfigured: boolean;
  canActivateFromProvider: boolean;
  canOneClickConnect: boolean;
  mask?: string;
}

interface ConnectorsResponse {
  connectors: ConnectorRow[];
}

type FilterChip = "all" | "connected" | "one-click" | ConnectorCategory;
type HubMode = "catalog" | "registry" | "custom";

// Category chips track the catalog so new categories appear without a UI change.
const CHIPS: ReadonlyArray<{ id: FilterChip; label: string }> = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "one-click", label: "1-Click Free" },
  ...CONNECTOR_CATEGORIES.filter(
    (category): category is { id: ConnectorCategory; label: string } => category.id !== "all",
  ).map((category) => ({ id: category.id, label: category.label })),
];

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function Modal({
  labelledBy,
  onClose,
  children,
}: Readonly<{
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    requestAnimationFrame(() => focusables()[0]?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab" && node) {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />
      <dialog
        ref={ref}
        open
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative z-10 w-full max-w-md rounded-2xl border border-white/15 bg-[#0e0f14] p-6 text-white shadow-2xl"
      >
        {children}
      </dialog>
    </div>
  );
}

function oneClickLabel(isBusy: boolean, canActivateFromProvider: boolean): string {
  if (isBusy) return "Connecting…";
  return canActivateFromProvider ? "Activate saved key" : "Connect";
}

function StatusBadge({ entry }: { entry: ConnectorRow }) {
  if (entry.connected) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
        <Check className="h-3 w-3" aria-hidden />
        Connected
      </span>
    );
  }
  if (entry.canActivateFromProvider) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2.5 py-0.5 text-[11px] font-medium text-cyan-200">
        Key in Providers
      </span>
    );
  }
  if (entry.fields.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
        1-Click
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-zinc-400">
      Not connected
    </span>
  );
}

interface ConnectorCardProps {
  entry: ConnectorRow;
  busy: boolean;
  anyBusy: boolean;
  onConnect: (entry: ConnectorRow) => void;
  onDisconnect: (entry: ConnectorRow) => void;
  onUpdate: (entry: ConnectorRow) => void;
}

function ConnectorActions({ entry, busy, anyBusy, onConnect, onDisconnect, onUpdate }: ConnectorCardProps) {
  if (entry.connected) {
    return (
      <>
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => void onDisconnect(entry)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Unplug className="h-3.5 w-3.5" aria-hidden />
          )}
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
        {entry.fields.length > 0 && (
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => onUpdate(entry)}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            <KeyRound className="h-3 w-3" aria-hidden />
            Update key
          </button>
        )}
      </>
    );
  }
  return (
    <>
      {entry.canOneClickConnect ? (
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => void onConnect(entry)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/35 bg-cyan-400/15 px-3.5 py-1.5 text-xs font-medium text-cyan-100 transition hover:bg-cyan-400/25 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plug className="h-3.5 w-3.5" aria-hidden />
          )}
          {oneClickLabel(busy, entry.canActivateFromProvider)}
        </button>
      ) : (
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => onUpdate(entry)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/35 bg-cyan-400/15 px-3.5 py-1.5 text-xs font-medium text-cyan-100 transition hover:bg-cyan-400/25 disabled:opacity-50"
        >
          <Plug className="h-3.5 w-3.5" aria-hidden />
          Connect
        </button>
      )}
      {entry.canActivateFromProvider && (
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => void onDisconnect(entry)}
          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
        >
          Disconnect
        </button>
      )}
    </>
  );
}

function ConnectorCard({ entry, busy, anyBusy, onConnect, onDisconnect, onUpdate }: ConnectorCardProps) {
  return (
    <article
      data-testid={`connector-card-${entry.id}`}
      className="flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-white/25 hover:bg-white/[0.05]"
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/15 text-xs font-bold tracking-wide"
              style={{
                backgroundColor: `${entry.accent}18`,
                color: entry.accent,
              }}
            >
              {initials(entry.name)}
            </span>
            <div>
              <h2 className="text-base font-semibold text-white">{entry.name}</h2>
              <p className="text-xs text-zinc-400">{entry.vendor}</p>
            </div>
          </div>
          <StatusBadge entry={entry} />
        </div>

        <p className="mt-3.5 text-sm leading-relaxed text-zinc-300">{entry.description}</p>

        <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Active capabilities
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">{entry.unlocks}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {entry.badges.map((badge) => (
              <span
                key={badge}
                className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
              >
                {badge}
              </span>
            ))}
            {entry.mask && (
              <span className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                {entry.mask}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <ConnectorActions
            entry={entry}
            busy={busy}
            anyBusy={anyBusy}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onUpdate={onUpdate}
          />
        </div>
        <a
          href={entry.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-cyan-200"
        >
          Docs
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <output className="mt-10 flex items-center gap-2.5 text-sm text-zinc-400">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden />
      Loading your connectors…
    </output>
  );
}

function ErrorState({ loadError, onRetry }: { loadError: string; onRetry: () => void }) {
  return (
    <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <p role="alert" className="text-sm text-red-200">
        {loadError}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        Retry
      </button>
    </div>
  );
}

function EmptyState({ onResetFilters }: { onResetFilters: () => void }) {
  return (
    <div className="mt-8 rounded-2xl border border-dashed border-white/15 p-10 text-center">
      <p className="text-sm font-medium text-zinc-200">No connectors match your filter</p>
      <p className="mt-1 text-xs text-zinc-400">Try clearing the search query or switching categories.</p>
      <button
        type="button"
        onClick={onResetFilters}
        className="mt-4 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/5"
      >
        Reset filters
      </button>
    </div>
  );
}

interface ContentViewProps {
  loading: boolean;
  loadError: string | null;
  filtered: ConnectorRow[];
  busyId: string | null;
  onRetry: () => void;
  onResetFilters: () => void;
  onConnect: (entry: ConnectorRow) => void;
  onDisconnect: (entry: ConnectorRow) => void;
  onUpdate: (entry: ConnectorRow) => void;
}

function ContentView({
  loading,
  loadError,
  filtered,
  busyId,
  onRetry,
  onResetFilters,
  onConnect,
  onDisconnect,
  onUpdate,
}: ContentViewProps) {
  if (loading) return <LoadingState />;
  if (loadError) return <ErrorState loadError={loadError} onRetry={onRetry} />;
  if (filtered.length === 0) return <EmptyState onResetFilters={onResetFilters} />;
  return (
    <section
      aria-label="Available connectors"
      className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
    >
      {filtered.map((entry) => (
        <ConnectorCard
          key={entry.id}
          entry={entry}
          busy={busyId === entry.id}
          anyBusy={Boolean(busyId)}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onUpdate={onUpdate}
        />
      ))}
    </section>
  );
}

export function ConnectorsPage() {
  const [hubMode, setHubMode] = useState<HubMode>("catalog");
  const [connectors, setConnectors] = useState<ConnectorRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<FilterChip>("all");
  const [visibleCount, setVisibleCount] = useState(60);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryRows, setRegistryRows] = useState<RegistryServerRow[] | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [customRows, setCustomRows] = useState<CustomConnectorRow[] | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [draft, setDraft] = useState<{
    entry: ConnectorRow;
    inputs: Record<string, string>;
    saving: boolean;
    error: string;
  } | null>(null);

  const loadCustom = useCallback(async () => {
    setCustomLoading(true);
    try {
      const res = await fetch("/api/connectors/custom", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { items?: CustomConnectorRow[] };
        setCustomRows(Array.isArray(data.items) ? data.items : []);
      }
    } catch {
      // ignore optional load errors
    } finally {
      setCustomLoading(false);
    }
  }, []);

  const searchRegistry = useCallback(async (q: string) => {
    setRegistryLoading(true);
    setRegistryError(null);
    try {
      const res = await fetch(`/api/connectors/registry?q=${encodeURIComponent(q)}&limit=30`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        servers?: RegistryServerRow[];
        error?: string;
      };
      if (!res.ok) {
        setRegistryError(data.error ?? "Could not search the MCP registry.");
        return;
      }
      setRegistryRows(Array.isArray(data.servers) ? data.servers : []);
    } catch {
      setRegistryError("Network error while querying the MCP registry.");
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/connectors", { cache: "no-store" });
      if (res.status === 401) {
        setLoadError("Sign in to manage account connectors.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLoadError(body.error ?? `Failed to load connectors (${res.status}).`);
        return;
      }
      const data = (await res.json()) as ConnectorsResponse;
      setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
    } catch {
      setLoadError("Could not reach the server. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCustom();
  }, [load, loadCustom]);

  useEffect(() => {
    if (hubMode === "registry" && registryRows === null && !registryLoading) {
      void searchRegistry("");
    }
  }, [hubMode, registryRows, registryLoading, searchRegistry]);

  const filtered = useMemo(() => {
    if (!connectors) return [];
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => {
      if (chip === "connected" && !c.connected) return false;
      if (chip === "one-click" && !c.canOneClickConnect) return false;
      if (chip !== "all" && chip !== "connected" && chip !== "one-click" && c.category !== chip) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.vendor.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.unlocks.toLowerCase().includes(q) ||
        c.badges.some((b) => b.toLowerCase().includes(q))
      );
    });
  }, [connectors, query, chip]);

  useEffect(() => {
    setVisibleCount(60);
  }, [query, chip]);

  const visibleFiltered = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const handleInstallRegistry = async (srv: RegistryServerRow) => {
    if (busyId) return;
    setBusyId(srv.id);
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch("/api/connectors/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: srv.id,
          name: srv.name,
          description: srv.description,
          transport: srv.transport === "stdio" ? "stdio" : "http",
          url: srv.url,
          packageManager: srv.packageManager,
          packageName: srv.packageName,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setActionError(data.error ?? `Could not install ${srv.name}.`);
        return;
      }
      setNotice(`${srv.name} installed into your VM --mcp-config.`);
      void loadCustom();
    } catch {
      setActionError(`Network error while installing ${srv.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveCustom = async (item: CustomConnectorRow) => {
    if (busyId) return;
    setBusyId(item.id);
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/connectors/custom?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? `Could not remove ${item.name}.`);
        return;
      }
      setNotice(`${item.name} removed from your VM tools.`);
      void loadCustom();
    } catch {
      setActionError(`Network error while removing ${item.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const connectedCount = useMemo(
    () => (connectors ?? []).filter((c) => c.connected).length,
    [connectors],
  );

  const updateRow = useCallback((updated: ConnectorRow) => {
    setConnectors((prev) =>
      prev ? prev.map((row) => (row.id === updated.id ? updated : row)) : prev,
    );
  }, []);

  const handleOneClickConnect = async (entry: ConnectorRow) => {
    if (busyId) return;
    setBusyId(entry.id);
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch("/api/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectorId: entry.id,
          useProviderKey: entry.canActivateFromProvider,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        connector?: ConnectorRow;
        error?: string;
      };
      if (!res.ok || !data.connector) {
        setActionError(data.error ?? `Could not connect ${entry.name}.`);
        return;
      }
      updateRow(data.connector);
      setNotice(`${entry.name} is now connected for your agent runs.`);
    } catch {
      setActionError(`Network error while connecting ${entry.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (entry: ConnectorRow) => {
    if (busyId) return;
    setBusyId(entry.id);
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        connector?: ConnectorRow;
        error?: string;
      };
      if (!res.ok || !data.connector) {
        setActionError(data.error ?? `Could not disconnect ${entry.name}.`);
        return;
      }
      updateRow(data.connector);
      setNotice(`${entry.name} was disconnected and removed from your active agent run configuration.`);
    } catch {
      setActionError(`Network error while disconnecting ${entry.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const openModal = (entry: ConnectorRow) => {
    setDraft({ entry, inputs: {}, saving: false, error: "" });
  };

  const handleSubmitModal = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || draft.saving) return;
    setDraft((prev) => (prev ? { ...prev, saving: true, error: "" } : prev));
    setNotice(null);
    setActionError(null);
    try {
      const res = await fetch("/api/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectorId: draft.entry.id,
          inputs: draft.inputs,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        connector?: ConnectorRow;
        error?: string;
      };
      if (!res.ok || !data.connector) {
        setDraft((prev) =>
          prev
            ? { ...prev, saving: false, error: data.error ?? `Could not connect ${prev.entry.name}.` }
            : prev,
        );
        return;
      }
      updateRow(data.connector);
      setNotice(`${draft.entry.name} connected. Sealed credentials are active for new VM runs.`);
      setDraft(null);
    } catch {
      setDraft((prev) =>
        prev ? { ...prev, saving: false, error: "Network error — could not connect." } : prev,
      );
    }
  };

  return (
    <main className="min-h-dvh bg-[#07070a] text-white antialiased">
      {/* Top navigation bar matching /library & /providers */}
      <nav
        aria-label="Workspace navigation"
        className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2.5 px-4 pt-6 sm:px-8"
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
            aria-current="page"
            className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1 text-xs font-medium text-cyan-200"
          >
            <Plug className="h-3 w-3" aria-hidden />
            Connectors
          </Link>
          <Link
            href="/providers"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
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

      <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-8">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300/80">
              One-click Integrations
            </p>
            <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-white">
              Connector Catalog
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Connect accounts and tools once. Credentials stay encrypted per user on the server
              and automatically wire into model routing, VM <code className="text-zinc-200">--mcp-config</code>,
              and the secret vault proxy — no repeated agent re-auth required.
            </p>
          </div>
          {connectors && (
            <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs text-zinc-300">
              <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
              <span>
                <strong className="font-semibold text-white tabular-nums">{connectedCount}</strong> of{" "}
                <span className="tabular-nums">{connectors.length}</span> active for agents
              </span>
            </div>
          )}
        </header>

        {/* Hub Mode Switcher */}
        <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
          <button
            type="button"
            onClick={() => setHubMode("catalog")}
            className={
              hubMode === "catalog"
                ? "inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-400/15 px-3.5 py-2 text-xs font-medium text-cyan-200 backdrop-blur-md"
                : "inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs text-zinc-400 hover:bg-white/[0.07] hover:text-white"
            }
          >
            <Plug className="h-3.5 w-3.5" aria-hidden />
            Verified Connectors ({connectors?.length ?? 44})
          </button>
          <button
            type="button"
            onClick={() => setHubMode("registry")}
            className={
              hubMode === "registry"
                ? "inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-400/15 px-3.5 py-2 text-xs font-medium text-cyan-200 backdrop-blur-md"
                : "inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs text-zinc-400 hover:bg-white/[0.07] hover:text-white"
            }
          >
            <Globe className="h-3.5 w-3.5" aria-hidden />
            Live MCP Registry (100s)
          </button>
          <button
            type="button"
            onClick={() => setHubMode("custom")}
            className={
              hubMode === "custom"
                ? "inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-400/15 px-3.5 py-2 text-xs font-medium text-cyan-200 backdrop-blur-md"
                : "inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs text-zinc-400 hover:bg-white/[0.07] hover:text-white"
            }
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            Custom & Agent-Authored ({customRows?.length ?? 0})
          </button>
        </div>
        {/* Search + Filter pills */}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
              aria-hidden
            />
            <input
              type="search"
              aria-label="Search connectors"
              placeholder="Search connectors, vendors, tools…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-[#111218] py-2 pl-9 pr-3 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
            />
          </label>
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">Connector categories</legend>
            <div className="flex flex-wrap items-center gap-1.5">
              {CHIPS.map((item) => {
              const active = chip === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setChip(item.id)}
                  className={
                    active
                      ? "rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-xs font-medium text-cyan-200"
                      : "rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white"
                  }
                >
                  {item.label}
                </button>
              );
            })}
            </div>
          </fieldset>
        </div>

        {hubMode === "catalog" && (
          <>
            {/* Search + Filter pills */}
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="relative block w-full sm:max-w-xs">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                />
                <input
                  type="search"
                  aria-label="Search connectors"
                  placeholder="Search GitHub, Slack, Postgres, Exa…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md py-2 pl-9 pr-3 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
                />
              </label>
              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className="sr-only">Connector categories</legend>
                <div className="flex flex-wrap items-center gap-1.5">
                  {CHIPS.map((item) => {
                  const active = chip === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setChip(item.id)}
                      className={
                        active
                          ? "rounded-full border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-xs font-medium text-cyan-200"
                          : "rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-white/[0.08] hover:text-white"
                      }
                    >
                      {item.label}
                    </button>
                  );
                })}
                </div>
              </fieldset>
            </div>
          </>
        )}

        {hubMode === "registry" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void searchRegistry(registryQuery);
            }}
            className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <label className="relative block flex-1">
              <Globe
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                aria-hidden
              />
              <input
                type="search"
                aria-label="Search official MCP Registry"
                placeholder="Search hundreds of live MCP servers (e.g. stripe, postgres, notion, github, memory)…"
                value={registryQuery}
                onChange={(e) => setRegistryQuery(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md py-2 pl-9 pr-3 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
              />
            </label>
            <button
              type="submit"
              disabled={registryLoading}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-cyan-300/35 bg-cyan-400/15 px-4 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {registryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Search className="h-3.5 w-3.5" aria-hidden />}
              Search Registry
            </button>
          </form>
        )}

        {/* Notifications */}
        {actionError && (
          <div
            role="alert"
            className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-red-400/30 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              className="rounded p-1 text-red-300 hover:bg-red-900/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {notice && (
          <div
            className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/30 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200"
          >
            <output className="flex-1">{notice}</output>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notice"
              className="rounded p-1 text-emerald-300 hover:bg-emerald-900/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Content */}
        {hubMode === "catalog" && (
          <>
            <ContentView
              loading={loading}
              loadError={loadError}
              filtered={visibleFiltered}
              busyId={busyId}
              onRetry={() => void load()}
              onResetFilters={() => {
                setQuery("");
                setChip("all");
              }}
              onConnect={handleOneClickConnect}
              onDisconnect={handleDisconnect}
              onUpdate={openModal}
            />
            {!loading && !loadError && filtered.length > visibleCount && (
              <div className="mt-6 flex flex-col items-center gap-2">
                <p className="text-xs text-zinc-500">
                  Showing {visibleFiltered.length} of {filtered.length} connectors
                </p>
                <button
                  type="button"
                  onClick={() => setVisibleCount((n) => n + 60)}
                  className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.08]"
                >
                  Load 60 more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </>
        )}

        {hubMode === "registry" && (
          <section className="mt-6" aria-label="Live MCP Registry results">
            {registryLoading && (
              <output className="mt-6 flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden />
                Searching official MCP Registry…
              </output>
            )}
            {registryError && (
              <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-950/40 p-4 text-sm text-red-200">
                {registryError}
              </p>
            )}
            {!registryLoading && !registryError && registryRows && registryRows.length === 0 && (
              <div className="mt-6 rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-zinc-400">
                No MCP servers matched &ldquo;{registryQuery}&rdquo;. Try another keyword.
              </div>
            )}
            {!registryLoading && registryRows && registryRows.length > 0 && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {registryRows.map((srv, idx) => {
                  const installable =
                    (srv.transport === "http" && Boolean(srv.url)) ||
                    (srv.transport === "stdio" && Boolean(srv.packageName));
                  return (
                    <article
                      key={`${srv.id}@${srv.version}-${idx}`}
                      className="flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-white/25"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="truncate text-sm font-semibold text-white">{srv.name}</h2>
                          <span className="shrink-0 rounded-full border border-white/15 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                            {srv.transport}
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                          {srv.description || "Official MCP registry server."}
                        </p>
                        {srv.packageName && (
                          <p className="mt-2 truncate font-mono text-[11px] text-cyan-300/80">
                            {srv.packageManager ?? "npx"} {srv.packageName}
                          </p>
                        )}
                      </div>
                      <div className="mt-4 flex items-center justify-between border-t border-white/[0.08] pt-3">
                        <span className="font-mono text-[10px] text-zinc-500">v{srv.version}</span>
                        {installable ? (
                          <button
                            type="button"
                            disabled={Boolean(busyId)}
                            onClick={() => void handleInstallRegistry(srv)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/35 bg-cyan-400/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-400/25 disabled:opacity-50"
                          >
                            {busyId === srv.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5" aria-hidden />
                            )}
                            Install to VM
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-500">Manual config</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {hubMode === "custom" && (
          <section className="mt-6" aria-label="Custom and agent-authored tools">
            {customLoading && (
              <output className="mt-6 flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden />
                Loading custom &amp; agent-authored MCPs…
              </output>
            )}
            {!customLoading && (!customRows || customRows.length === 0) && (
              <div className="mt-6 rounded-2xl border border-dashed border-white/15 p-10 text-center">
                <p className="text-sm font-medium text-zinc-200">No custom or agent-authored MCPs installed yet</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Install servers from the Live MCP Registry tab, or ask your agent inside the VM to author and register a custom tool.
                </p>
              </div>
            )}
            {!customLoading && customRows && customRows.length > 0 && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {customRows.map((item) => (
                  <article
                    key={item.id}
                    className="flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-5"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="truncate text-sm font-semibold text-white">{item.name}</h2>
                        <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
                          {item.origin === "agent" ? "Agent-authored" : item.kind}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-zinc-400">{item.description}</p>
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-white/[0.08] pt-3">
                      <span className="font-mono text-[10px] text-zinc-500">{item.id}</span>
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => void handleRemoveCustom(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Credential connection dialog */}
      {draft && (
        <Modal
          labelledBy="connector-modal-title"
          onClose={() => {
            if (!draft.saving) setDraft(null);
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-cyan-300">
                {draft.entry.connected ? "Update credential" : "Connect service"}
              </p>
              <h2 id="connector-modal-title" className="mt-1 text-lg font-semibold text-white">
                {draft.entry.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => {
                if (!draft.saving) setDraft(null);
              }}
              aria-label="Close modal"
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-2 text-xs leading-relaxed text-zinc-400">
            Encrypted per account with AES-256-GCM. Never shown back to the browser or written in
            plaintext to shared logs.
          </p>

          <form onSubmit={(e) => void handleSubmitModal(e)} className="mt-5 space-y-4">
            {draft.entry.fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`connector-field-${field.key}`}
                    className="block text-xs font-medium text-zinc-200"
                  >
                    {field.label}
                  </label>
                  {field.helpUrl && (
                    <a
                      href={field.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline"
                    >
                      Get token
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  )}
                </div>
                <input
                  id={`connector-field-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  required={field.required}
                  placeholder={field.placeholder ?? ""}
                  value={draft.inputs[field.key] ?? ""}
                  disabled={draft.saving}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((prev) =>
                      prev ? { ...prev, inputs: { ...prev.inputs, [field.key]: value } } : prev,
                    );
                  }}
                  className="w-full rounded-xl border border-white/15 bg-[#151720] px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
                />
                {field.hint && <p className="text-[11px] text-zinc-500">{field.hint}</p>}
              </div>
            ))}

            {draft.error && (
              <p role="alert" className="rounded-lg border border-red-400/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                {draft.error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={draft.saving}
                onClick={() => setDraft(null)}
                className="rounded-xl border border-white/10 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={draft.saving}
                className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-300/40 bg-cyan-400/20 px-4 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/30 disabled:opacity-50"
              >
                {draft.saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Plug className="h-3.5 w-3.5" aria-hidden />
                )}
                {draft.saving ? "Saving…" : draft.entry.connected ? "Save key" : "Connect"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
