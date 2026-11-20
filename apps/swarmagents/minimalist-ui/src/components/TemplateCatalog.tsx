"use client";

/**
 * Template gallery (x4).
 *
 * A searchable, filterable grid of ready-made tasks. Opening a template shows
 * the full prompt, a form for its variables, and a written example of what
 * "done" looks like. Pressing Run starts a real run on the user's own VM with
 * the template's recommended role.
 *
 * The catalog itself is static and shipped with the app; it is fetched from
 * GET /api/templates so the browser bundle does not carry 60 written prompts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Loader2, Play, Search, Sparkles, Wrench, X } from "lucide-react";
import type { TaskTemplate, TemplateCategory } from "../../../lib/templates/types";
import { TEMPLATE_CATEGORIES } from "../../../lib/templates/types";

/** Fallback category labels; the API sends the same map so the UI stays in sync. */
const DEFAULT_CATEGORY_NAMES: Record<string, string> = {
  "build-an-app": "Build an app",
  "fix-or-refactor-code": "Fix / refactor code",
  "research-and-reports": "Research and reports",
  "data-and-spreadsheets": "Data and spreadsheets",
  "web-automation-in-the-vm-browser": "Web automation",
  "devops-and-servers": "DevOps and servers",
  "content-and-docs": "Content and docs",
  "personal-productivity": "Personal productivity",
};

interface CatalogResponse {
  templates: TaskTemplate[];
  categories?: Array<{ id: TemplateCategory; label: string; blurb: string }>;
}

export interface TemplateCatalogData {
  templates: TaskTemplate[];
  categories?: CatalogResponse["categories"];
  loading: boolean;
  error?: string;
}

/**
 * Load the catalog. Exported so the workspace can show a few template
 * shortcuts on the empty workspace without a second copy of the data.
 */
export function useTemplateCatalog(): TemplateCatalogData {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [categories, setCategories] = useState<CatalogResponse["categories"]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`templates responded ${res.status}`);
        return (await res.json()) as CatalogResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
        if (Array.isArray(data.categories)) setCategories(data.categories);
        setError(undefined);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Could not load the template gallery.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { templates, categories, loading, error };
}

export interface TemplateCatalogProps {
  /**
   * Starts the run. Receives the template and the user's answers; the
   * implementation decides whether to show the run in this page or navigate
   * to the workspace.
   */
  onRun: (template: TaskTemplate, values: Record<string, string>) => Promise<void>;
  /** Called when the user closes the gallery (drawer variant only). */
  onClose?: () => void;
  /** Show the gallery as a full page (default) or inside a drawer. */
  variant?: "page" | "drawer";
  /**
   * Open this template as soon as the catalog has loaded. The workspace uses
   * it when a template is picked from the empty-workspace strip.
   */
  initialTemplateId?: string;
}

/** The starting value of one field: its default, or the first select option. */
function fieldInitialValue(field: TaskTemplate["fields"][number]): string {
  if (field.default !== undefined) return field.default;
  if (field.type === "select" && field.options && field.options.length > 0) return field.options[0];
  return "";
}

/** The prompt with its {{variables}} highlighted, split into plain/var parts. */
function promptParts(prompt: string): Array<{ text: string; variable: boolean }> {
  const parts: Array<{ text: string; variable: boolean }> = [];
  let last = 0;
  for (const match of prompt.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: prompt.slice(last, start), variable: false });
    parts.push({ text: match[1], variable: true });
    last = start + match[0].length;
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last), variable: false });
  return parts;
}

export function TemplateCatalog({ onRun, onClose, variant = "page", initialTemplateId }: TemplateCatalogProps) {
  const { templates, categories, loading, error: loadError } = useTemplateCatalog();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [openId, setOpenId] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const autoOpenedRef = useRef<string | undefined>(undefined);

  const categoryNames = useMemo(() => {
    const names: Record<string, string> = { ...DEFAULT_CATEGORY_NAMES };
    for (const entry of categories ?? []) names[entry.id] = entry.label;
    return names;
  }, [categories]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const terms = needle.split(/\s+/).filter(Boolean);
    return templates.filter((template) => {
      if (category !== "all" && template.category !== category) return false;
      if (!terms.length) return true;
      const haystack = [template.title, template.pitch, categoryNames[template.category] ?? "", template.prompt]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [templates, query, category, categoryNames]);

  const open = useMemo(() => templates.find((template) => template.id === openId), [templates, openId]);

  const openTemplate = useCallback((template: TaskTemplate) => {
    const initial: Record<string, string> = {};
    for (const field of template.fields) initial[field.name] = fieldInitialValue(field);
    setValues(initial);
    setRunError(undefined);
    setOpenId(template.id);
  }, []);

  const closeTemplate = useCallback(() => {
    setOpenId(undefined);
    setRunError(undefined);
  }, []);

  // A template picked from the empty-workspace strip opens the drawer with
  // that template ready to run, as soon as the catalog has loaded.
  useEffect(() => {
    if (!initialTemplateId || autoOpenedRef.current === initialTemplateId) return;
    const template = templates.find((candidate) => candidate.id === initialTemplateId);
    if (!template) return;
    autoOpenedRef.current = initialTemplateId;
    openTemplate(template);
  }, [initialTemplateId, templates, openTemplate]);

  // Escape closes the preview.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTemplate();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeTemplate]);

  const run = useCallback(async () => {
    if (!open || running) return;
    setRunning(true);
    setRunError(undefined);
    try {
      await onRun(open, values);
    } catch (err) {
      setRunError((err as Error).message || "Could not start the run.");
      setRunning(false);
    }
  }, [open, values, running, onRun]);

  const countByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const template of templates) counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
    return counts;
  }, [templates]);

  const controls = (
    <>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search 60 task templates…"
            aria-label="Search templates"
            data-testid="template-search"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          />
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Template categories">
          <button
            type="button"
            onClick={() => setCategory("all")}
            aria-pressed={category === "all"}
            className={`rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
              category === "all"
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
            }`}
          >
            All ({templates.length})
          </button>
          {TEMPLATE_CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setCategory(id)}
              aria-pressed={category === id}
              className={`rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
                category === id
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                  : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
              }`}
            >
              {categoryNames[id] ?? id} ({countByCategory.get(id) ?? 0})
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading templates…
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {loadError}
        </p>
      )}
      {!loading && !loadError && visible.length === 0 && (
        <p className="py-10 text-center text-sm text-white/45">
          No template matches “{query.trim()}”. Try a shorter search.
        </p>
      )}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="template-grid">
        {visible.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              onClick={() => openTemplate(template)}
              data-testid="template-card"
              data-template-id={template.id}
              className="flex h-full w-full flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-cyan-400/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold leading-snug text-white">{template.title}</span>
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400/70" aria-hidden="true" />
              </span>
              <span className="text-xs leading-relaxed text-white/55">{template.pitch}</span>
              <span className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-[10px] text-white/40">
                <span className="rounded-full border border-white/10 px-2 py-0.5">
                  {categoryNames[template.category] ?? template.category}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {template.estimatedMinutes} min
                </span>
                <span className="inline-flex items-center gap-1">
                  <Wrench className="h-3 w-3" aria-hidden="true" />
                  {template.role}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  const preview = open && (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-drawer-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeTemplate();
      }}
    >
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-white/10 bg-[#0c0c11] p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-300/70">
              {categoryNames[open.category] ?? open.category}
            </p>
            <h2 id="template-drawer-title" className="mt-1 text-lg font-semibold text-white">
              {open.title}
            </h2>
            <p className="mt-1 text-xs text-white/50">{open.pitch}</p>
          </div>
          <button
            type="button"
            onClick={closeTemplate}
            aria-label="Close template"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/45">
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Estimated time</dt>
            <Clock className="h-3 w-3" aria-hidden="true" />
            <dd>~{open.estimatedMinutes} min</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Role</dt>
            <Wrench className="h-3 w-3" aria-hidden="true" />
            <dd>{open.role}</dd>
          </div>
          <div>
            <dt className="sr-only">Tools</dt>
            <dd>tools: {open.tools.join(", ")}</dd>
          </div>
          {open.mcp.length > 0 && (
            <div>
              <dt className="sr-only">MCP servers</dt>
              <dd>mcp: {open.mcp.join(", ")}</dd>
            </div>
          )}
        </dl>

        {open.fields.length > 0 && (
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-white/40">Fill it in</h3>
            {open.fields.map((field) => (
              <div key={field.name} className="space-y-1.5">
                <label htmlFor={`template-field-${field.name}`} className="block text-xs font-medium text-white/70">
                  {field.label}
                </label>
                {field.type === "select" ? (
                  <select
                    id={`template-field-${field.name}`}
                    value={values[field.name] ?? ""}
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    className="w-full rounded-xl border border-white/10 bg-[#15151a] px-3 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea
                    id={`template-field-${field.name}`}
                    value={values[field.name] ?? ""}
                    placeholder={field.placeholder}
                    rows={3}
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    className="w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                  />
                ) : (
                  <input
                    id={`template-field-${field.name}`}
                    type="text"
                    value={values[field.name] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                  />
                )}
                {field.help && <p className="text-[11px] text-white/35">{field.help}</p>}
              </div>
            ))}
          </form>
        )}

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-white/40">The prompt</h3>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/65">
            {promptParts(open.prompt).map((part, index) =>
              part.variable ? (
                <span key={index} className="rounded bg-cyan-400/15 px-1 text-cyan-200">
                  {part.text}
                </span>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </pre>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-white/40">Example of the result</h3>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px] leading-relaxed text-white/60">
            {open.example}
          </pre>
        </section>

        {runError && (
          <p role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {runError}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3 pb-2">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            data-testid="template-run"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black transition hover:bg-white/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {running ? "Starting…" : "Run this template"}
          </button>
          <span className="text-[11px] text-white/35">Runs on your own VM with the {open.role} role.</span>
        </div>
      </div>
    </div>
  );

  if (variant === "drawer") {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="template-catalog">
        {onClose && (
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Template gallery</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close template gallery"
              className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {controls}
        {preview}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5" data-testid="template-catalog">
      {controls}
      {preview}
    </div>
  );
}
