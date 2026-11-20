"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, ExternalLink, Loader2, Network, Plug, Plus, Search, Wrench } from "lucide-react";
import { LibraryApiError, type InstalledItem } from "../../../lib/client/library";
import {
  addSwarmCatalogEntry,
  CATALOG_CATEGORIES,
  filterSwarmCatalog,
  loadSwarmCatalog,
  PROVIDER_SETTINGS_URL,
  type CatalogCategory,
  type SwarmCatalogEntry,
} from "../../../lib/client/swarm-catalog";
import { LIBRARY_KIND_LABELS, LIBRARY_KINDS, LIMITS, type LibraryKind } from "../../../lib/library/types";

const ICONS = { connector: Plug, mcp: Network, skill: BookOpen, tool: Wrench };
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70";
const INPUT = `min-w-0 rounded-lg border border-white/10 bg-[#121217] px-3 py-2.5 text-sm text-zinc-100 ${FOCUS}`;
const ACTION = `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-300/20 disabled:opacity-45 ${FOCUS}`;
const QUIET_ACTION = `inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-white/5 ${FOCUS}`;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof LibraryApiError) {
    if (error.status === 401) return "Sign in to manage your swarm catalog.";
    if (error.status < 500) return error.message;
  }
  return fallback;
}

function Installed({ entry }: { entry: SwarmCatalogEntry }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-300">
      <Check className="h-3.5 w-3.5" aria-hidden="true" /> {entry.add.via === "provider-settings" ? "Connected" : "Added"}
    </span>
  );
}

function EntryIcon({ kind }: { kind: LibraryKind }) {
  const Icon = ICONS[kind];
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.035] text-zinc-300">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

function needsSetup(entry: SwarmCatalogEntry): boolean {
  return entry.add.via === "provider-settings" || (entry.add.via === "connector" && entry.add.fields.length > 0);
}

export function SwarmCatalog({ onAdded }: { onAdded: (item: InstalledItem) => void }) {
  const headingId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const addingRef = useRef(false);
  const [entries, setEntries] = useState<SwarmCatalogEntry[]>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LibraryKind | "all">("all");
  const [category, setCategory] = useState<CatalogCategory | "all">("all");
  const [detailId, setDetailId] = useState<string>();
  const [adding, setAdding] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [addError, setAddError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadSwarmCatalog()
      .then((data) => { if (active) setEntries(data); })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error, "Could not load the catalog. Check your connection and try again."));
      });
    return () => { active = false; };
  }, [attempt]);

  const detail = entries?.find((entry) => entry.id === detailId);
  const results = entries ? filterSwarmCatalog(entries, query, kind, category) : [];

  async function add(entry: SwarmCatalogEntry, inputs?: Record<string, string>): Promise<boolean> {
    if (addingRef.current || entry.installed) return false;
    addingRef.current = true;
    setAdding(entry.id);
    setNotice(undefined);
    setAddError(undefined);
    try {
      const item = await addSwarmCatalogEntry(entry, inputs);
      setEntries((current) => current?.map((row) => row.id === entry.id ? { ...row, installed: true } : row));
      onAdded(item);
      setNotice(`${entry.name} was added to your library for the next VM run.`);
      return true;
    } catch (error) {
      setAddError(errorMessage(error, `Could not add ${entry.name}. Check your connection and try again.`));
      return false;
    } finally {
      addingRef.current = false;
      setAdding(undefined);
    }
  }

  function open(entry: SwarmCatalogEntry) {
    setDetailId(entry.id);
    setAddError(undefined);
    setNotice(undefined);
  }

  function back() {
    setDetailId(undefined);
    setAddError(undefined);
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-3xl px-1 py-3 sm:px-4 sm:py-6" data-testid="swarm-catalog">
      {detail ? (
        <CatalogDetail key={detail.id} entry={detail} headingId={headingId} busy={Boolean(adding)} adding={adding === detail.id}
          onBack={back} onAdd={(inputs) => add(detail, inputs)} />
      ) : (
        <>
          <header className="mb-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/80">Extend your swarm</p>
            <h2 id={headingId} className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-50">Capability catalog</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">Browse verified connectors, MCP servers, skills and tools for your swarm.</p>
          </header>
          <div className="space-y-2.5">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
              <input ref={searchRef} type="search" aria-label="Search catalog" placeholder="Search capabilities…"
                value={query} onChange={(event) => setQuery(event.target.value)} className={`${INPUT} w-full pl-9`} />
            </label>
            <div className="flex flex-wrap items-center gap-2" aria-label="Catalog filters" role="group">
              <select aria-label="Filter by type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className={`${INPUT} !py-1.5 text-xs`}>
                <option value="all">All types</option>
                {LIBRARY_KINDS.map((value) => <option key={value} value={value}>{LIBRARY_KIND_LABELS[value]}</option>)}
              </select>
              <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value as typeof category)} className={`${INPUT} !py-1.5 text-xs`}>
                <option value="all">All categories</option>
                {Object.entries(CATALOG_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {entries && <span className="ml-auto text-xs tabular-nums text-zinc-400" aria-live="polite">{results.length} {results.length === 1 ? "result" : "results"}</span>}
            </div>
          </div>

          {loadError ? (
            <div className="mt-5 rounded-xl border border-white/10 p-4">
              <p role="alert" className="mb-3 text-sm text-red-200">{loadError}</p>
              <button type="button" className={QUIET_ACTION} onClick={() => { setLoadError(undefined); setAttempt((n) => n + 1); }}>Retry</button>
            </div>
          ) : !entries ? (
            <p role="status" className="mt-5 flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading catalog…
            </p>
          ) : results.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-white/15 p-6 text-center">
              <p className="text-sm font-medium text-zinc-100">No matching capabilities</p>
              <p className="mt-1 text-xs text-zinc-400">Try another search or clear the filters.</p>
              <button type="button" className={`${QUIET_ACTION} mt-3`} onClick={() => { setQuery(""); setKind("all"); setCategory("all"); }}>Clear filters</button>
            </div>
          ) : (
            <ul className="mt-5 divide-y divide-white/[0.08] border-y border-white/[0.08]">
              {results.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 py-3 sm:gap-4" data-testid="catalog-entry">
                  <button type="button" onClick={() => open(entry)} aria-label={`Details for ${entry.name}`} className={`group flex min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left sm:gap-3 ${FOCUS}`}>
                    <EntryIcon kind={entry.kind} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-zinc-50 group-hover:text-cyan-200">{entry.name}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">{entry.description}</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-zinc-400">{entry.vendor} · {LIBRARY_KIND_LABELS[entry.kind]} · {CATALOG_CATEGORIES[entry.category]}</span>
                    </span>
                  </button>
                  {entry.installed ? <Installed entry={entry} /> : needsSetup(entry) ? (
                    <button type="button" aria-label={`Set up ${entry.name}`} onClick={() => open(entry)} className={QUIET_ACTION}>Set up</button>
                  ) : (
                    <button type="button" aria-label={`Add ${entry.name}`} disabled={Boolean(adding)} onClick={() => void add(entry)} className={ACTION}>
                      {adding === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                      {adding === entry.id ? "Adding…" : "Add"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {addError && <p role="alert" className="sticky bottom-2 mt-4 rounded-lg border border-red-400/30 bg-[#1b1015] p-3 text-sm text-red-200">{addError}</p>}
      {notice && <p role="status" className="sticky bottom-2 mt-4 rounded-lg border border-emerald-400/25 bg-[#0d1817] p-3 text-sm text-emerald-200">{notice}</p>}
    </section>
  );
}

function CatalogDetail({ entry, headingId, busy, adding, onBack, onAdd }: {
  entry: SwarmCatalogEntry;
  headingId: string;
  busy: boolean;
  adding: boolean;
  onBack: () => void;
  onAdd: (inputs: Record<string, string>) => Promise<boolean>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const fields = entry.add.via === "connector" ? entry.add.fields : [];

  useEffect(() => { headingRef.current?.focus(); }, []);

  return (
    <div data-testid="catalog-detail">
      <button type="button" onClick={onBack} className={QUIET_ACTION}><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to catalog</button>
      <div className="mt-5 flex items-start gap-3 border-b border-white/10 pb-5">
        <EntryIcon kind={entry.kind} />
        <div>
          <h2 ref={headingRef} tabIndex={-1} id={headingId} className="text-xl font-semibold tracking-tight text-zinc-50 outline-none">{entry.name}</h2>
          <p className="mt-0.5 text-xs text-zinc-400">{entry.vendor} · {LIBRARY_KIND_LABELS[entry.kind]} · {CATALOG_CATEGORIES[entry.category]}</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">{entry.description}</p>
        </div>
      </div>
      <dl className="space-y-4 py-5 text-sm">
        <div><dt className="font-medium text-zinc-100">What it unlocks</dt><dd className="mt-1 leading-relaxed text-zinc-400">{entry.unlocks}</dd></div>
        <div><dt className="font-medium text-zinc-100">Setup</dt><dd className="mt-1 leading-relaxed text-zinc-400">{entry.setup}</dd></div>
      </dl>
      <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 rounded text-xs text-cyan-200 underline-offset-4 hover:underline ${FOCUS}`}>
        View official source <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
      <div className="mt-5 border-t border-white/10 pt-5">
        {entry.add.via === "provider-settings" ? (
          <div className="flex flex-wrap items-center gap-3">
            {entry.installed && <Installed entry={entry} />}
            <Link href={PROVIDER_SETTINGS_URL} className={ACTION}>Open Provider Settings</Link>
          </div>
        ) : entry.installed ? <Installed entry={entry} /> : (
          <form onSubmit={(event) => {
            event.preventDefault();
            void onAdd(inputs).then((added) => { if (added) setInputs({}); });
          }}>
            {fields.length > 0 && (
              <fieldset className="mb-4 space-y-3" disabled={busy}>
                <legend className="mb-1 text-sm font-medium text-zinc-100">Connector settings</legend>
                <p className="text-xs text-zinc-400">Credentials are encrypted in your account. They are not published to the library.</p>
                {fields.map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <label htmlFor={`${headingId}-${field.key}`} className="block text-xs font-medium text-zinc-200">{field.label}</label>
                    <input id={`${headingId}-${field.key}`} type={field.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
                      value={inputs[field.key] ?? ""} onChange={(event) => setInputs((current) => ({ ...current, [field.key]: event.target.value }))}
                      maxLength={LIMITS.secretValue} required className={`${INPUT} w-full max-w-md`} />
                    {field.helpUrl && <a href={field.helpUrl} target="_blank" rel="noreferrer" className={`block w-fit rounded text-xs text-cyan-200 underline-offset-4 hover:underline ${FOCUS}`}>Setup instructions <ExternalLink className="inline h-3 w-3" aria-hidden="true" /></a>}
                  </div>
                ))}
              </fieldset>
            )}
            <button type="submit" disabled={busy || fields.some((field) => !inputs[field.key]?.trim())} className={ACTION}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              {adding ? "Adding…" : "Add to swarm"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
