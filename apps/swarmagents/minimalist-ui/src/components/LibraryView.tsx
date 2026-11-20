"use client";

/**
 * The Library surface: browse the shared public catalog, inspect the full
 * SKILL.md/code before installing, install a copy into this account, report
 * or (admin) unpublish an item, publish your own work, and manage the
 * connectors/MCP servers/skills/tools you already own. The curated Swarm
 * Catalog shares the existing Library install paths.
 *
 * Only the parts of an item that are safe to show are ever displayed: a
 * required secret is rendered as an input (or a last-4 mask), never as text.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  BadgeCheck,
  Check,
  Download,
  Flag,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  LibraryApiError,
  libraryApi,
  type InstalledItem,
  type LibraryNotification,
  type ProofView,
  type PublicItemDetail,
  type PublicItemSummary,
  type TestDriveView,
} from "../../../lib/client/library";
import type { LibraryKind, LibraryPayload } from "../../../lib/library/types";
import { SwarmCatalog } from "./SwarmCatalog";

type Tab = "browse" | "catalog" | "mcp" | "skills" | "tools";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "browse", label: "Browse" },
  { id: "catalog", label: "Catalog" },
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Tools" },
];

const KIND_LABEL: Record<LibraryKind, string> = {
  skill: "Skill",
  tool: "Tool",
  mcp: "MCP server",
  connector: "Connector",
};

function when(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

function errorText(error: unknown): string {
  return error instanceof LibraryApiError ? error.message : error instanceof Error ? error.message : "Something went wrong.";
}

function fullContent(item: PublicItemDetail): string {
  const payload = item.payload;
  if (payload.kind === "skill") {
    const extra = payload.files.length
      ? "\n\n--- supporting files ---\n" +
        payload.files.map((file) => `\n### ${file.path}\n${file.content}`).join("\n")
      : "";
    return payload.skillMd + extra;
  }
  if (payload.kind === "tool") {
    return `${payload.code}\n\n--- input schema ---\n${JSON.stringify(payload.inputSchema, null, 2)}`;
  }
  return JSON.stringify(payload, null, 2);
}

function payloadSummary(payload: LibraryPayload): string {
  if (payload.kind === "skill") return `${payload.skillMd.length.toLocaleString()} characters of SKILL.md`;
  if (payload.kind === "tool") return `JavaScript tool, ${payload.timeoutMs / 1000}s timeout`;
  return `${payload.transport} MCP server`;
}

export function LibraryView({ embedded = false }: { embedded?: boolean }) {
  const [tab, setTab] = useState<Tab>("browse");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [me, setMe] = useState<{ user: string; admin: boolean; publishLimitPerHour: number } | null>(null);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | LibraryKind>("all");
  const [sort, setSort] = useState<"installs" | "newest" | "updated" | "name">("installs");
  const [publicItems, setPublicItems] = useState<PublicItemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [detail, setDetail] = useState<PublicItemDetail | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);

  // F4 test-drive state for the open detail dialog.
  const [drive, setDrive] = useState<TestDriveView | null>(null);
  const [drivePrompt, setDrivePrompt] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);

  const [installed, setInstalled] = useState<InstalledItem[]>([]);
  const [notifications, setNotifications] = useState<LibraryNotification[]>([]);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishKind, setPublishKind] = useState<LibraryKind>("skill");
  const [publishSourceId, setPublishSourceId] = useState("");
  const [publishName, setPublishName] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishLicense, setPublishLicense] = useState("MIT");
  const [publishBody, setPublishBody] = useState("");
  const [publishTransport, setPublishTransport] = useState<"http" | "stdio">("http");
  const [publishTarget, setPublishTarget] = useState("");
  const [publishing, setPublishing] = useState(false);
  // F4: optional finished run to attach as a signed proof-of-run bundle.
  const [proofRuns, setProofRuns] = useState<Array<{ runId: string; prompt: string; status: string }>>([]);
  const [publishProofRunId, setPublishProofRunId] = useState("");

  const refreshPublic = useCallback(async () => {
    setLoading(true);
    try {
      const data = await libraryApi.listPublic({ q: query, kind: kindFilter, sort });
      setPublicItems(data.items);
      setTotal(data.total);
      setMe((current) => ({
        user: current?.user ?? "",
        admin: data.canModerate,
        publishLimitPerHour: data.publishLimitPerHour,
      }));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [query, kindFilter, sort]);

  const refreshInstalled = useCallback(async () => {
    try {
      const data = await libraryApi.listItems();
      setInstalled(data.items);
      setNotifications(data.notifications);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void libraryApi.me().then(setMe).catch(() => undefined);
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    if (tab === "browse") void refreshPublic();
    if (tab === "mcp" || tab === "skills" || tab === "tools") void refreshInstalled();
  }, [tab, refreshPublic, refreshInstalled]);

  // F4: when the publish form opens, offer the publisher's recent finished
  // runs as proof-of-run candidates.
  useEffect(() => {
    if (!publishOpen) return;
    let cancelled = false;
    void fetch("/api/runtime/runs?limit=20", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          runs?: Array<{ runId: string; prompt: string; status: string }>;
        };
        if (!cancelled && Array.isArray(body.runs)) {
          setProofRuns(body.runs.filter((run) => run.status === "finished"));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [publishOpen]);

  // F4: poll the active test-drive while it is running or awaiting a
  // keep/roll-back decision; the server auto-rolls back a failed drive.
  useEffect(() => {
    if (!detail || !drive || (drive.status !== "running" && drive.status !== "awaiting-decision")) {
      return;
    }
    const timer = window.setInterval(() => {
      void libraryApi
        .getTestDrive(detail.id, drive.id)
        .then((data) => setDrive(data.drive))
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [detail, drive]);

  const installedForKind = useMemo(() => {
    if (tab === "mcp") return installed.filter((item) => item.kind === "mcp" || item.kind === "connector");
    if (tab === "skills") return installed.filter((item) => item.kind === "skill");
    if (tab === "tools") return installed.filter((item) => item.kind === "tool");
    return installed;
  }, [tab, installed]);

  async function openDetail(id: string) {
    try {
      const data = await libraryApi.getPublic(id);
      setDetail(data.item);
      setSecretValues({});
      setDrive(null);
      setDrivePrompt("");
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function startTestDrive(item: PublicItemDetail) {
    setDriveBusy(true);
    try {
      const data = await libraryApi.startTestDrive(item.id, drivePrompt.trim() || undefined);
      setDrive(data.drive);
      setNotice(
        `Test-drive started — your VM was snapshotted first (${data.snapshotLabel}). The run is marked as a test-drive; keep or roll back when it finishes.`,
      );
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDriveBusy(false);
    }
  }

  async function decideTestDrive(item: PublicItemDetail, action: "keep" | "rollback") {
    if (!drive) return;
    setDriveBusy(true);
    try {
      const data =
        action === "keep"
          ? await libraryApi.keepTestDrive(item.id, drive.id)
          : await libraryApi.rollbackTestDrive(item.id, drive.id);
      setDrive(data.drive);
      setNotice(
        action === "keep"
          ? "Kept the test-drive result. Your VM stays as the drive left it."
          : "Rolled back — your VM is back at the pre-drive snapshot.",
      );
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDriveBusy(false);
    }
  }

  async function install(item: PublicItemDetail) {
    setInstalling(true);
    try {
      await libraryApi.install(item.id, secretValues);
      setNotice(`Installed "${item.name}" into your library. Runs can use it now.`);
      setDetail(null);
      await refreshInstalled();
      await refreshPublic();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setInstalling(false);
    }
  }

  async function report(item: PublicItemSummary) {
    const reason = typeof window === "undefined" ? "" : window.prompt(`Why are you reporting "${item.name}"?`);
    if (!reason) return;
    try {
      const result = await libraryApi.report(item.id, reason);
      setNotice(`Reported "${item.name}". ${result.reportCount} report(s) so far.`);
      await refreshPublic();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function unpublish(item: PublicItemSummary) {
    if (typeof window !== "undefined" && !window.confirm(`Unpublish "${item.name}" from the public catalog?`)) return;
    try {
      await libraryApi.unpublish(item.id);
      setNotice(`Unpublished "${item.name}".`);
      setDetail(null);
      await refreshPublic();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function review(item: PublicItemSummary) {
    try {
      await libraryApi.review(item.id);
      setNotice(`Marked "${item.name}" reviewed.`);
      await refreshPublic();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function publish() {
    setPublishing(true);
    try {
      const proof = publishProofRunId ? { proofRunId: publishProofRunId } : {};
      let proofError: string | undefined;
      if (publishSourceId) {
        const res = await libraryApi.publish({
          sourceItemId: publishSourceId,
          ...(publishName.trim() ? { name: publishName.trim() } : {}),
          ...(publishDescription.trim() ? { description: publishDescription.trim() } : {}),
          ...(publishLicense.trim() ? { license: publishLicense.trim() } : {}),
          ...proof,
        });
        proofError = (res as { proofError?: string }).proofError;
      } else {
        let payload: unknown;
        if (publishKind === "skill") payload = { skillMd: publishBody, files: [], requiredFields: [] };
        else if (publishKind === "tool") {
          payload = {
            code: publishBody,
            language: "javascript",
            inputSchema: { type: "object", properties: {} },
            requiredFields: [],
            timeoutMs: 30000,
          };
        } else {
          payload =
            publishTransport === "http"
              ? { transport: "http", url: publishTarget, requiredFields: [] }
              : { transport: "stdio", command: publishTarget.trim().split(/\s+/)[0], args: publishTarget.trim().split(/\s+/).slice(1), requiredFields: [] };
        }
        const res = await libraryApi.publish({
          kind: publishKind,
          name: publishName,
          description: publishDescription,
          license: publishLicense,
          payload,
          ...proof,
        });
        proofError = (res as { proofError?: string }).proofError;
      }
      setPublishOpen(false);
      setPublishSourceId("");
      setPublishName("");
      setPublishDescription("");
      setPublishBody("");
      setPublishTarget("");
      setPublishProofRunId("");
      setNotice(
        proofError
          ? `Published, but the proof-of-run could not be attached: ${proofError}`
          : publishProofRunId
            ? "Published with a verified proof-of-run badge."
            : "Published. It is labelled unreviewed until an admin reviews it.",
      );
      await refreshPublic();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPublishing(false);
    }
  }

  async function addInline(kind: "skill" | "tool") {
    const name = typeof window === "undefined" ? "" : window.prompt(`Name the new ${kind}`);
    if (!name) return;
    const body = typeof window === "undefined" ? "" : window.prompt(kind === "skill" ? "Paste the SKILL.md" : "Paste the JavaScript tool body");
    if (!body) return;
    try {
      await libraryApi.addItem({
        kind,
        name,
        description: "",
        payload:
          kind === "skill"
            ? { skillMd: body, files: [], requiredFields: [] }
            : { language: "javascript", code: body, inputSchema: { type: "object", properties: {} }, requiredFields: [], timeoutMs: 30000 },
      });
      setNotice(`Added ${name}.`);
      await refreshInstalled();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove(item: InstalledItem) {
    if (typeof window !== "undefined" && !window.confirm(`Remove "${item.name}" from your library?`)) return;
    try {
      await libraryApi.deleteItem(item.id);
      setNotice(`Removed "${item.name}".`);
      await refreshInstalled();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-[#08080c] text-zinc-200" data-testid="library-view">
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.07] px-2 py-1.5">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`library-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
              tab === entry.id ? "bg-white/[0.08] text-zinc-50" : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {entry.label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setPublishOpen((open) => !open)}
          className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/15"
          data-testid="library-publish-open"
        >
          <Upload className="h-3 w-3" aria-hidden /> Publish
        </button>
      </div>

      {notifications.length > 0 && (
        <div className="border-b border-amber-400/20 bg-amber-400/[0.06] px-3 py-2" data-testid="library-updates">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-200">
            <RefreshCw className="h-3 w-3" aria-hidden /> Updates available — your copies are unchanged until you reinstall
          </p>
          <ul className="mt-1 space-y-0.5">
            {notifications.map((note) => (
              <li key={note.itemId} className="text-[11px] text-amber-100/80">
                {note.name}: v{note.fromVersion} → v{note.toVersion}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-300/70 hover:text-red-100">Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 border-b border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[11px] text-emerald-200">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-emerald-300/70 hover:text-emerald-100">Dismiss</button>
        </div>
      )}

      {publishOpen && (
        <PublishForm
          kind={publishKind}
          onKind={setPublishKind}
          sourceId={publishSourceId}
          onSourceId={setPublishSourceId}
          installed={installed}
          name={publishName}
          onName={setPublishName}
          description={publishDescription}
          onDescription={setPublishDescription}
          license={publishLicense}
          onLicense={setPublishLicense}
          body={publishBody}
          onBody={setPublishBody}
          transport={publishTransport}
          onTransport={setPublishTransport}
          target={publishTarget}
          onTarget={setPublishTarget}
          publishing={publishing}
          onSubmit={publish}
          proofRuns={proofRuns}
          proofRunId={publishProofRunId}
          onProofRunId={setPublishProofRunId}
        />
      )}

      <div className="sa-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "browse" && (
          <section aria-label="Public catalog">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative flex min-w-[150px] flex-1 items-center">
                <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-zinc-500" aria-hidden />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search public skills, tools, servers…"
                  aria-label="Search public library"
                  className="w-full rounded-md border border-white/10 bg-black/30 py-1.5 pl-7 pr-2 text-[12px] outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
                />
              </label>
              <select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as "all" | LibraryKind)}
                aria-label="Filter by kind"
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]"
              >
                <option value="all">All kinds</option>
                <option value="skill">Skills</option>
                <option value="tool">Tools</option>
                <option value="mcp">MCP servers</option>
                <option value="connector">Connectors</option>
              </select>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
                aria-label="Sort public library"
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]"
              >
                <option value="installs">Most installed</option>
                <option value="newest">Newest</option>
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
              </select>
              <button type="button" onClick={() => void refreshPublic()} className="rounded-md border border-white/10 p-1.5 hover:bg-white/[0.05]" aria-label="Refresh public library">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArrowDownWideNarrow className="h-3.5 w-3.5" aria-hidden />}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              {total} item{total === 1 ? "" : "s"} · new submissions are <span className="text-amber-300">unreviewed</span> · installs are copies
            </p>
            <ul className="mt-3 space-y-2">
              {publicItems.map((item) => (
                <li key={item.id} data-testid="library-public-item" className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{KIND_LABEL[item.kind]}</span>
                        <span className="text-[13px] font-medium text-zinc-100">{item.name}</span>
                        <span className="text-[11px] text-zinc-500">v{item.version}</span>
                        {item.moderation === "unreviewed" ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                            <ShieldAlert className="h-3 w-3" aria-hidden /> unreviewed
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200">reviewed</span>
                        )}
                        {item.proofVerified && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200" title="Signed proof: this exact version ran to completion in a clean VM">
                            <BadgeCheck className="h-3 w-3" aria-hidden /> proof-of-run
                          </span>
                        )}
                        {item.reportCount > 0 && (
                          <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-[10px] text-red-200">{item.reportCount} report{item.reportCount === 1 ? "" : "s"}</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-zinc-400">{item.description || "No description."}</p>
                      <p className="mt-1 text-[10px] text-zinc-600">
                        @{item.authorHandle} · {item.installs} install{item.installs === 1 ? "" : "s"} · {item.license || "no license"} · updated {when(item.updatedAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <button type="button" onClick={() => void openDetail(item.id)} className="rounded-md border border-white/10 px-2 py-1 text-[11px] hover:bg-white/[0.06]" data-testid="library-preview-open">
                        View full content
                      </button>
                      <button type="button" onClick={() => void report(item)} className="rounded-md border border-white/10 p-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-red-300" aria-label={`Report ${item.name}`}>
                        <Flag className="h-3 w-3" aria-hidden />
                      </button>
                      {me?.admin && item.moderation !== "reviewed" && (
                        <button type="button" onClick={() => void review(item)} className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200">
                          Mark reviewed
                        </button>
                      )}
                      {(me?.admin || item.authorHandle === displayHandle(me?.user)) && (
                        <button type="button" onClick={() => void unpublish(item)} className="rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11px] text-red-200">
                          Unpublish
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {publicItems.length === 0 && !loading && (
                <li className="rounded-xl border border-dashed border-white/10 p-6 text-center text-[12px] text-zinc-500">
                  Nothing published yet. Publish a skill or tool to start the shared catalog.
                </li>
              )}
            </ul>
          </section>
        )}

        {tab === "catalog" && (
          <SwarmCatalog onAdded={(item) => setInstalled((current) => [...current.filter((row) => row.id !== item.id), item])} />
        )}

        {(tab === "mcp" || tab === "skills" || tab === "tools") && (
          <section aria-label={`Installed ${tab}`}>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-zinc-500">Items installed in this account. They are seeded into your VM before each run.</p>
              {(tab === "skills" || tab === "tools") && (
                <button type="button" onClick={() => void addInline(tab === "skills" ? "skill" : "tool")} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] hover:bg-white/[0.06]">
                  <Plus className="h-3 w-3" aria-hidden /> Add {tab === "skills" ? "skill" : "tool"}
                </button>
              )}
            </div>
            <ul className="mt-3 space-y-2">
              {installedForKind.map((item) => (
                <li key={item.id} data-testid="library-installed-item" className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-zinc-100">{item.name}</span>
                        <span className="text-[11px] text-zinc-500">v{item.version}</span>
                        {item.origin === "public" && <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-zinc-400">from public catalog</span>}
                        {item.origin === "agent" && <span className="inline-flex items-center gap-1 rounded bg-indigo-400/10 px-1.5 py-0.5 text-[10px] text-indigo-200"><Sparkles className="h-3 w-3" aria-hidden /> agent-made</span>}
                        {item.updateAvailable && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">update available</span>}
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">{item.description || payloadSummary(item.payload)}</p>
                      {item.secretFields.length > 0 && (
                        <p className="mt-1 text-[10px] text-zinc-600">
                          Secrets: {item.secretFields.map((field) => `${field.key}${field.configured ? ` (${field.mask ?? "set"})` : " (missing)"}`).join(", ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {item.updateAvailable && item.sourcePublicId && (
                        <button
                          type="button"
                          onClick={() => void openDetail(item.sourcePublicId!)}
                          className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200"
                        >
                          Review update
                        </button>
                      )}
                      <button type="button" onClick={() => void remove(item)} className="rounded-md border border-white/10 p-1.5 text-zinc-400 hover:bg-red-400/10 hover:text-red-300" aria-label={`Remove ${item.name}`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
              {installedForKind.length === 0 && (
                <li className="rounded-xl border border-dashed border-white/10 p-6 text-center text-[12px] text-zinc-500">Nothing installed in this tab yet.</li>
              )}
            </ul>
          </section>
        )}

        {embedded && <p className="mt-4 text-[10px] text-zinc-600">All runs execute installed skills and tools inside your own Linux VM.</p>}
      </div>

      {detail && (
        <div className="absolute inset-0 z-10 flex flex-col bg-[#08080c]/98" role="dialog" aria-modal="true" aria-label={`${detail.name} preview`} data-testid="library-preview">
          <div className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-zinc-100">{detail.name} <span className="text-zinc-500">v{detail.version}</span></p>
              <p className="text-[10px] text-zinc-500">@{detail.authorHandle} · {detail.license || "no license"} · {KIND_LABEL[detail.kind]} · untrusted content — review it in full before installing</p>
            </div>
            <button type="button" onClick={() => setDetail(null)} className="rounded-md border border-white/10 px-2 py-1 text-[11px] hover:bg-white/[0.06]">Close</button>
          </div>
          <div className="sa-scroll min-h-0 flex-1 overflow-y-auto p-3">
            {detail.moderation === "unreviewed" && (
              <p className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-2 py-1.5 text-[11px] text-amber-200">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> This submission is unreviewed. Read the entire content before installing.
              </p>
            )}
            {detail.proof && <ProofPanel proof={detail.proof} />}
            <TestDriveSection
              item={detail}
              drive={drive}
              prompt={drivePrompt}
              onPrompt={setDrivePrompt}
              busy={driveBusy}
              onStart={() => void startTestDrive(detail)}
              onDecide={(action) => void decideTestDrive(detail, action)}
            />
            <pre className="mt-2 max-h-[45vh] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300" data-testid="library-preview-content">{fullContent(detail)}</pre>
            {detail.requiredFields.length > 0 && (
              <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <p className="text-[11px] font-medium text-zinc-200">Secrets required for your install</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">These are field names only. Publisher secrets are never shared; values you enter are encrypted in your account.</p>
                <div className="mt-2 space-y-2">
                  {detail.requiredFields.map((field) => (
                    <label key={field.key} className="block">
                      <span className="text-[11px] text-zinc-300">{field.label} <span className="font-mono text-[10px] text-zinc-500">{field.key}</span></span>
                      <input
                        type="password"
                        value={secretValues[field.key] ?? ""}
                        onChange={(event) => setSecretValues((current) => ({ ...current, [field.key]: event.target.value }))}
                        className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cyan-400/50"
                        autoComplete="off"
                      />
                      {field.helpUrl && <a href={field.helpUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-[10px] text-cyan-300/80 hover:text-cyan-200">Where to get this</a>}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-3 py-2">
            <button type="button" onClick={() => void report(detail)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-400 hover:text-red-300">
              <Flag className="h-3 w-3" aria-hidden /> Report
            </button>
            {detail.canUnpublish && (
              <button type="button" onClick={() => void unpublish(detail)} className="rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11px] text-red-200">Unpublish</button>
            )}
            <button
              type="button"
              onClick={() => void install(detail)}
              disabled={installing}
              data-testid="library-install"
              className="inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-medium text-cyan-100 disabled:opacity-50"
            >
              {installing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Download className="h-3 w-3" aria-hidden />}
              Install a copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function displayHandle(user: string | undefined): string {
  if (!user) return "";
  const base = user.startsWith("local_") ? user.slice("local_".length) : user;
  const at = base.indexOf("@");
  return at > 0 ? base.slice(0, at) : base;
}

function PublishForm(props: {
  kind: LibraryKind;
  onKind: (kind: LibraryKind) => void;
  sourceId: string;
  onSourceId: (id: string) => void;
  installed: InstalledItem[];
  name: string;
  onName: (value: string) => void;
  description: string;
  onDescription: (value: string) => void;
  license: string;
  onLicense: (value: string) => void;
  body: string;
  onBody: (value: string) => void;
  transport: "http" | "stdio";
  onTransport: (value: "http" | "stdio") => void;
  target: string;
  onTarget: (value: string) => void;
  publishing: boolean;
  onSubmit: () => void;
  proofRuns: Array<{ runId: string; prompt: string; status: string }>;
  proofRunId: string;
  onProofRunId: (id: string) => void;
}) {
  return (
    <div className="border-b border-cyan-400/20 bg-cyan-400/[0.04] p-3" data-testid="library-publish-form">
      <p className="text-[12px] font-medium text-cyan-100">Publish to the public catalog</p>
      <p className="mt-0.5 text-[10px] text-cyan-100/60">Secret values are never published. Publishing from your library copies the content and lists required field names for installers.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Publish from library</span>
          <select value={props.sourceId} onChange={(event) => props.onSourceId(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]">
            <option value="">— paste content instead —</option>
            {props.installed.map((item) => (
              <option key={item.id} value={item.id}>{item.name} ({KIND_LABEL[item.kind]})</option>
            ))}
          </select>
        </label>
        {!props.sourceId && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Kind</span>
            <select value={props.kind} onChange={(event) => props.onKind(event.target.value as LibraryKind)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]">
              <option value="skill">Skill</option>
              <option value="tool">Tool</option>
              <option value="mcp">MCP server</option>
              <option value="connector">Connector</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Name</span>
          <input value={props.name} onChange={(event) => props.onName(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]" placeholder={props.sourceId ? "Use the item name" : "Required"} />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">License</span>
          <input value={props.license} onChange={(event) => props.onLicense(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]" placeholder="MIT" />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Description</span>
          <input value={props.description} onChange={(event) => props.onDescription(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]" />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Proof-of-run (optional)</span>
          <select value={props.proofRunId} onChange={(event) => props.onProofRunId(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]">
            <option value="">— no proof attached (stays unreviewed) —</option>
            {props.proofRuns.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId} · {(run.prompt || "untitled run").slice(0, 60)}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-[10px] text-zinc-500">
            Attach a finished run of yours as a signed proof bundle: browsers can scrub its replay, diff and cost, and the entry shows a verified badge. Only finished runs qualify.
          </span>
        </label>
        {!props.sourceId && (props.kind === "skill" || props.kind === "tool") && (
          <label className="block sm:col-span-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">{props.kind === "skill" ? "SKILL.md" : "JavaScript code (body of async main(args))"}</span>
            <textarea value={props.body} onChange={(event) => props.onBody(event.target.value)} rows={6} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px]" />
          </label>
        )}
        {!props.sourceId && (props.kind === "mcp" || props.kind === "connector") && (
          <>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Transport</span>
              <select value={props.transport} onChange={(event) => props.onTransport(event.target.value as "http" | "stdio")} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]">
                <option value="http">HTTP</option>
                <option value="stdio">stdio</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">{props.transport === "http" ? "URL" : "Command + args"}</span>
              <input value={props.target} onChange={(event) => props.onTarget(event.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]" />
            </label>
          </>
        )}
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={props.onSubmit} disabled={props.publishing} className="inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-medium text-cyan-100 disabled:opacity-50" data-testid="library-publish-submit">
          {props.publishing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Upload className="h-3 w-3" aria-hidden />}
          Publish
        </button>
      </div>
    </div>
  );
}

/** F4: verified proof-of-run — scrubbable replay, artifact diff, cost. */
function ProofPanel({ proof }: { proof: ProofView }) {
  const [shotIndex, setShotIndex] = useState(0);
  const shot = proof.shots[shotIndex];
  const duration =
    proof.durationMs !== undefined
      ? proof.durationMs >= 60_000
        ? `${(proof.durationMs / 60_000).toFixed(1)} min`
        : `${(proof.durationMs / 1000).toFixed(0)}s`
      : "—";
  return (
    <div className="mb-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.05] p-3" data-testid="library-proof">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-emerald-200">
        <BadgeCheck className="h-4 w-4" aria-hidden /> Verified proof-of-run
        <span className="font-normal text-emerald-200/70">
          · v{proof.version} ran to completion in a clean {proof.vmImage}
        </span>
      </p>
      <p className="mt-1 text-[11px] text-zinc-400">
        Signed by this server and bound to this exact version — the badge only appears when the
        signature verifies. Prompt: <span className="text-zinc-300">{proof.prompt || "(no prompt recorded)"}</span>
      </p>
      <div className="mt-2 grid gap-2 text-[11px] text-zinc-300 sm:grid-cols-4">
        <span>Cost: <strong className="text-zinc-100">{proof.costUsd !== undefined ? `$${proof.costUsd.toFixed(4)}` : "—"}</strong></span>
        <span>Duration: <strong className="text-zinc-100">{duration}</strong></span>
        <span>Model: <strong className="text-zinc-100">{proof.model ?? "—"}</strong></span>
        <span>Providers: <strong className="text-zinc-100">{proof.providers.join(", ") || "—"}</strong></span>
      </div>
      {proof.shots.length > 0 && shot && (
        <div className="mt-2">
          <div className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot.url} alt={`Proof replay frame: ${shot.label}`} className="max-h-[240px] w-full object-contain" />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={proof.shots.length - 1}
              value={shotIndex}
              onChange={(event) => setShotIndex(Number(event.target.value))}
              aria-label="Scrub proof replay"
              data-testid="library-proof-scrubber"
              className="w-full accent-emerald-300"
            />
            <span className="shrink-0 text-[10px] text-zinc-500">
              {shotIndex + 1}/{proof.shots.length} · {shot.label}
            </span>
          </div>
        </div>
      )}
      {proof.steps.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-zinc-200">
            Run timeline ({proof.steps.length} steps)
          </summary>
          <ol className="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-[10px] text-zinc-400">
            {proof.steps.map((step) => (
              <li key={`${step.seq}-${step.kind}`} className="flex gap-2">
                <span className="shrink-0 text-zinc-600">#{step.seq}</span>
                <span className="truncate">{step.text}</span>
                {step.ok === false && <span className="shrink-0 text-red-300">failed</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="mt-2">
        <p className="text-[11px] font-medium text-zinc-200">
          Files changed ({proof.artifacts.length}
          {proof.shotsTotal > proof.shots.length ? ` · ${proof.shotsTotal} screenshots in the run, ${proof.shots.length} stored` : ""})
        </p>
        {proof.artifacts.length > 0 ? (
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto font-mono text-[10px] text-zinc-400">
            {proof.artifacts.map((artifact) => (
              <li key={artifact.rel} className="flex gap-2">
                <span className={artifact.change === "created" ? "text-emerald-300" : "text-amber-300"}>
                  {artifact.change === "created" ? "+" : "~"}
                </span>
                <span className="truncate">{artifact.rel}</span>
                <span className="ml-auto shrink-0 text-zinc-600">{artifact.size.toLocaleString()} B</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-0.5 text-[10px] text-zinc-500">No files changed under /workspace.</p>
        )}
      </div>
    </div>
  );
}

/** F4: test-drive an unreviewed entry in an isolated ephemeral snapshot. */
function TestDriveSection(props: {
  item: PublicItemDetail;
  drive: TestDriveView | null;
  prompt: string;
  onPrompt: (value: string) => void;
  busy: boolean;
  onStart: () => void;
  onDecide: (action: "keep" | "rollback") => void;
}) {
  const { item, drive } = props;
  const report = drive?.report;
  return (
    <div className="mb-2 rounded-lg border border-white/10 bg-white/[0.02] p-3" data-testid="library-test-drive">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-100">
        <FlaskConical className="h-4 w-4 text-cyan-300" aria-hidden /> Test-drive in an isolated snapshot
      </p>
      <p className="mt-0.5 text-[11px] text-zinc-500">
        Your VM is snapshotted first, the skill runs once inside the snapshot, and you keep the
        result or roll back. A failed or abandoned drive rolls back on its own. The drive run is
        marked as a test-drive — it is never confused with a normal run.
      </p>
      {!drive && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={props.prompt}
            onChange={(event) => props.onPrompt(event.target.value)}
            placeholder="What should the drive try? (optional)"
            aria-label="Test-drive instructions"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
          />
          <button
            type="button"
            onClick={props.onStart}
            disabled={props.busy}
            data-testid="library-test-drive-start"
            className="inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-medium text-cyan-100 disabled:opacity-50"
          >
            {props.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}
            Start test-drive
          </button>
        </div>
      )}
      {drive && (
        <div className="mt-2 space-y-2 text-[11px]">
          <p className="text-zinc-300">
            Drive <span className="font-mono text-[10px]">{drive.id}</span> · run{" "}
            <span className="font-mono text-[10px]">{drive.runId}</span> · status{" "}
            <strong>{drive.status}</strong> · run {drive.runStatus} · snapshot{" "}
            <span className="font-mono text-[10px]">{drive.snapshotLabel}</span>
          </p>
          {drive.lastError && (
            <p role="alert" className="rounded border border-red-400/20 bg-red-400/[0.07] px-2 py-1 text-red-200">
              {drive.lastError}
            </p>
          )}
          {drive.status === "running" && (
            <p className="flex items-center gap-1.5 text-zinc-400">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Drive run in progress — the diff appears here when it finishes.
            </p>
          )}
          {report && (
            <div className="rounded border border-white/10 bg-black/30 p-2">
              <p className="text-zinc-200">
                Result: <strong>{report.status}</strong>
                {report.costUsd !== undefined && <> · ${report.costUsd.toFixed(4)}</>}
                {report.durationMs !== undefined && <> · {(report.durationMs / 1000).toFixed(0)}s</>}
                {report.model && <> · {report.model}</>}
              </p>
              <p className="mt-1 font-medium text-zinc-200">Files changed ({report.artifacts.length})</p>
              {report.artifacts.length > 0 ? (
                <ul className="mt-0.5 max-h-24 space-y-0.5 overflow-auto font-mono text-[10px] text-zinc-400">
                  {report.artifacts.map((artifact) => (
                    <li key={artifact.rel} className="flex gap-2">
                      <span className={artifact.change === "created" ? "text-emerald-300" : "text-amber-300"}>
                        {artifact.change === "created" ? "+" : "~"}
                      </span>
                      <span className="truncate">{artifact.rel}</span>
                      <span className="ml-auto shrink-0 text-zinc-600">{artifact.size.toLocaleString()} B</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-0.5 text-[10px] text-zinc-500">No files changed under /workspace.</p>
              )}
              <p className="mt-1 text-zinc-400">
                {report.steps.length} steps · {report.shots} screenshots
                {report.couldNotDo.length > 0 && ` · could not do: ${report.couldNotDo.join("; ")}`}
              </p>
            </div>
          )}
          {drive.status === "awaiting-decision" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => props.onDecide("keep")}
                disabled={props.busy}
                data-testid="library-test-drive-keep"
                className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-400/15 px-3 py-1.5 text-[11px] font-medium text-emerald-100 disabled:opacity-50"
              >
                <Check className="h-3 w-3" aria-hidden /> Keep the result
              </button>
              <button
                type="button"
                onClick={() => props.onDecide("rollback")}
                disabled={props.busy}
                data-testid="library-test-drive-rollback"
                className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/15 px-3 py-1.5 text-[11px] font-medium text-amber-100 disabled:opacity-50"
              >
                <Undo2 className="h-3 w-3" aria-hidden /> Roll back to the snapshot
              </button>
            </div>
          )}
          {drive.status === "rolled-back" && (
            <p className="text-amber-200">
              Rolled back{drive.rollbackReason === "run-failed" ? " automatically — the drive run failed" : drive.rollbackReason === "superseded" ? " — superseded by a newer drive" : ""}. Your VM is back at the pre-drive snapshot.
            </p>
          )}
          {drive.status === "kept" && (
            <p className="text-emerald-200">Kept. Your VM stays as the drive left it.</p>
          )}
          {drive.status !== "running" && drive.status !== "awaiting-decision" && (
            <button
              type="button"
              onClick={props.onStart}
              disabled={props.busy}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] hover:bg-white/[0.06] disabled:opacity-50"
            >
              <FlaskConical className="h-3 w-3" aria-hidden /> Run another test-drive
            </button>
          )}
        </div>
      )}
    </div>
  );
}
