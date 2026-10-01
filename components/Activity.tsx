"use client";

// Activity: the task board and results view.
//
// This is the "shown prettily" half of the runtime control plane. It answers, at a
// glance: what is the agent working on, what is paused and why, what did it cost, and
// what did it produce. It is a self-contained client component: it subscribes to the
// runtime SSE stream and renders tasks, their live progress, a per-task run ledger and
// the artifacts they generated.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, RunRecord, RuntimeSettings, StepRecord, Task, TaskStatus } from "@/lib/runtime/types";
import "./Activity.css";

interface BoardTask extends Task {
  progress?: { pct: number; label: string };
  usageSummary?: string;
}

interface Detail {
  task: BoardTask;
  ledger: { runs: RunRecord[]; steps: StepRecord[] };
  artifacts: Artifact[];
}

const STATUS_META: Record<TaskStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "queued" },
  running: { label: "Running", cls: "running" },
  waiting: { label: "Waiting", cls: "waiting" },
  blocked: { label: "Needs you", cls: "blocked" },
  done: { label: "Done", cls: "done" },
  failed: { label: "Failed", cls: "failed" },
  cancelled: { label: "Cancelled", cls: "cancelled" },
};

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function relTime(ts?: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function Activity({ onClose, onOpenSession }: { onClose: () => void; onOpenSession?: (sessionId: string) => void }) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/runtime/tasks").then((x) => x.json());
    setTasks(r.tasks ?? []);
    setSettings(r.settings ?? null);
  }, []);

  // Live board via the runtime stream; fall back to polling if SSE drops.
  useEffect(() => {
    refresh();
    const es = new EventSource("/api/runtime/stream");
    esRef.current = es;
    es.onmessage = (m) => {
      const op = JSON.parse(m.data) as { op: string; tasks?: BoardTask[] };
      if (op.op === "snapshot" && op.tasks) setTasks(op.tasks);
      else refresh();
    };
    es.onerror = () => {
      // EventSource reconnects on its own; a refresh keeps the view honest meanwhile.
      void refresh();
    };
    return () => es.close();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string) => {
    const r = await fetch(`/api/runtime/tasks/${id}`).then((x) => x.json());
    setDetail(r);
  }, []);

  useEffect(() => {
    if (open) void loadDetail(open);
  }, [open, loadDetail]);

  const act = useCallback(
    async (id: string, action: string, extra: Record<string, unknown> = {}) => {
      await fetch(`/api/runtime/tasks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      await refresh();
      if (open === id) await loadDetail(id);
    },
    [refresh, loadDetail, open],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  return (
    <div className="activity-overlay" onClick={onClose}>
      <div className="activity" onClick={(e) => e.stopPropagation()}>
        <header className="activity-head">
          <div>
            <h2>Activity</h2>
            <p className="activity-sub">
              {counts.running ? `${counts.running} running` : "Idle"}
              {counts.queued ? ` · ${counts.queued} queued` : ""}
              {counts.waiting ? ` · ${counts.waiting} waiting` : ""}
              {counts.blocked ? ` · ${counts.blocked} need you` : ""}
            </p>
          </div>
          <div className="activity-head-actions">
            <button className="btn" onClick={() => setShowSettings((s) => !s)}>
              Runtime settings
            </button>
            <button className="btn" onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>
        </header>

        {showSettings && settings && (
          <RuntimeSettingsForm
            settings={settings}
            onChange={(next) => {
              setSettings(next);
              void fetch("/api/runtime/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(next),
              });
            }}
          />
        )}

        <div className="activity-body">
          <div className="activity-list">
            {!tasks.length && (
              <div className="activity-empty">
                <p>No tasks yet.</p>
                <p className="dim">
                  Ask the agent for something. Long jobs land here, keep running when paused on quota, and survive restarts.
                </p>
              </div>
            )}
            {tasks.map((t) => (
              <button
                key={t.id}
                className={`task-card${open === t.id ? " on" : ""}`}
                onClick={() => setOpen(open === t.id ? null : t.id)}
              >
                <div className="task-row">
                  <span className={`task-dot ${STATUS_META[t.status].cls}`} />
                  <span className="task-title">{t.title}</span>
                  <span className={`task-badge ${STATUS_META[t.status].cls}`}>{STATUS_META[t.status].label}</span>
                </div>
                <div className="task-progress">
                  <div className="task-bar">
                    <div className={`task-fill ${STATUS_META[t.status].cls}`} style={{ width: `${t.progress?.pct ?? 0}%` }} />
                  </div>
                  <span className="task-label">{t.progress?.label}</span>
                </div>
                <div className="task-meta">
                  <span>{t.usageSummary}</span>
                  <span>{relTime(t.updatedAt)}</span>
                </div>
                {t.wait?.message && t.status !== "running" && <div className="task-wait">{t.wait.message}</div>}
              </button>
            ))}
          </div>

          <div className="activity-detail">
            {!detail && open && <div className="activity-empty">Loading…</div>}
            {!detail && !open && <div className="activity-empty dim">Select a task to see its runs, steps and results.</div>}
            {detail && open === detail.task.id && (
              <TaskDetail
                detail={detail}
                onAction={(action, extra) => act(detail.task.id, action, extra)}
                onOpenSession={onOpenSession}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskDetail({
  detail,
  onAction,
  onOpenSession,
}: {
  detail: Detail;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { task, ledger, artifacts } = detail;
  const runs = [...ledger.runs].reverse();
  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h3>{task.title}</h3>
          <p className="detail-prompt">{task.prompt}</p>
        </div>
        <div className="detail-actions">
          {onOpenSession && (
            <button className="btn" onClick={() => onOpenSession(task.sessionId)}>
              Open chat
            </button>
          )}
          {(task.status === "waiting" || task.status === "blocked") && (
            <button className="btn primary" onClick={() => onAction("resume")}>
              Resume
            </button>
          )}
          {task.status === "running" && (
            <button className="btn" onClick={() => onAction("pause")}>
              Pause
            </button>
          )}
          {(task.status === "failed" || task.status === "cancelled" || task.status === "done") && (
            <button className="btn" onClick={() => onAction("retry")}>
              Retry
            </button>
          )}
          {task.status !== "done" && task.status !== "cancelled" && (
            <button className="btn danger" onClick={() => onAction("cancel")}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="detail-stats">
        <Stat label="Status" value={STATUS_META[task.status].label} />
        <Stat label="Attempts" value={String(task.attempts)} />
        <Stat label="Tokens" value={fmtTok(task.usage.inputTokens + task.usage.outputTokens)} />
        <Stat label="Cost" value={task.usage.costUsd > 0 ? `$${task.usage.costUsd.toFixed(2)}` : "—"} />
        <Stat label="Turns" value={String(task.usage.turns)} />
        <Stat label="Tools" value={String(task.usage.toolCalls)} />
      </div>

      {task.budget.maxTokens > 0 || task.budget.maxCostUsd > 0 || task.budget.maxDurationMs > 0 ? (
        <div className="detail-budget">
          <span className="group-ttl">Budget</span>
          <div className="budget-bars">
            {task.budget.maxTokens > 0 && (
              <BudgetBar
                label="Tokens"
                used={task.usage.inputTokens + task.usage.outputTokens}
                max={task.budget.maxTokens}
              />
            )}
            {task.budget.maxCostUsd > 0 && <BudgetBar label="Cost" used={task.usage.costUsd} max={task.budget.maxCostUsd} money />}
            {task.budget.maxDurationMs > 0 && (
              <BudgetBar
                label="Time"
                used={task.startedAt ? Date.now() - task.startedAt : 0}
                max={task.budget.maxDurationMs}
                time
              />
            )}
          </div>
        </div>
      ) : null}

      {task.result && (
        <div className="detail-result">
          <span className="group-ttl">
            Result {task.result.verified ? "· verified" : ""}
          </span>
          <p>{task.result.summary}</p>
        </div>
      )}

      <div className="detail-section">
        <span className="group-ttl">Results {artifacts.length ? `· ${artifacts.length}` : ""}</span>
        {!artifacts.length && <p className="dim">Artifacts the agent produces will appear here.</p>}
        <div className="artifacts">
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} a={a} onKeep={(kept) => onAction("keep-artifact", { artifactId: a.id, kept })} />
          ))}
        </div>
      </div>

      <div className="detail-section">
        <span className="group-ttl">Runs</span>
        {runs.map((r) => (
          <div key={r.id} className="run">
            <div className="run-head">
              <span className={`task-dot ${r.status === "done" ? "done" : r.status === "failed" ? "failed" : r.status === "interrupted" ? "waiting" : "running"}`} />
              <span>Attempt {r.attempt}</span>
              <span className="run-when">{new Date(r.startedAt).toLocaleString()}</span>
              <span className="run-meta">
                {fmtTok(r.usage.inputTokens + r.usage.outputTokens)} tok · {r.usage.turns} turns · {r.usage.toolCalls} tools
              </span>
            </div>
            {!!r.notes.length && (
              <ul className="run-notes">
                {r.notes.slice(-6).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {!runs.length && <p className="dim">Not started yet.</p>}
      </div>

      <div className="detail-section">
        <span className="group-ttl">Recent steps</span>
        <ol className="steps">
          {[...ledger.steps].reverse().slice(0, 40).map((s) => (
            <li key={s.id} className={s.kind + (s.ok === false ? " bad" : "")}>
              <span className="step-time">{new Date(s.ts).toLocaleTimeString()}</span>
              <span className="step-label">{s.label}</span>
              {s.detail && <span className="step-detail">{s.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-v">{value}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

function BudgetBar({ label, used, max, money, time }: { label: string; used: number; max: number; money?: boolean; time?: boolean }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  const fmt = (v: number) => (money ? `$${v.toFixed(2)}` : time ? `${Math.round(v / 60000)}m` : fmtTok(Math.round(v)));
  return (
    <div className="budget">
      <div className="budget-top">
        <span>{label}</span>
        <span className={pct > 90 ? "over" : ""}>
          {fmt(used)} / {fmt(max)}
        </span>
      </div>
      <div className="budget-track">
        <div className={`budget-fill${pct > 90 ? " over" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const KIND_ICON: Record<Artifact["kind"], string> = {
  file: "📄",
  image: "🖼️",
  diff: "±",
  url: "🔗",
  text: "T",
  log: "▤",
  data: "{ }",
};

function ArtifactCard({ a, onKeep }: { a: Artifact; onKeep: (kept: boolean) => void }) {
  const href = `/api/runtime/artifacts/${a.id}`;
  return (
    <div className="artifact">
      <div className="artifact-top">
        <span className="artifact-icon">{KIND_ICON[a.kind]}</span>
        <span className="artifact-title" title={a.path ?? a.url ?? a.title}>
          {a.title}
        </span>
      </div>
      {a.kind === "image" && <img className="artifact-img" src={href} alt={a.title} loading="lazy" />}
      {a.kind === "url" && a.url && (
        <a className="artifact-link" href={a.url} target="_blank" rel="noreferrer">
          {a.url}
        </a>
      )}
      <div className="artifact-foot">
        {a.size ? <span className="dim">{Math.ceil(a.size / 1024)} KB</span> : <span className="dim">{a.text ? "inline" : ""}</span>}
        <span className="spacer" />
        <a className="artifact-open" href={`${href}?download=1`} download>
          Download
        </a>
        <button className="artifact-keep" onClick={() => onKeep(!a.kept)}>
          {a.kept ? "Kept ✓" : "Keep"}
        </button>
      </div>
    </div>
  );
}

function RuntimeSettingsForm({ settings, onChange }: { settings: RuntimeSettings; onChange: (s: RuntimeSettings) => void }) {
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  return (
    <div className="runtime-settings">
      <label className="rs-row">
        <span>Resume automatically after quota waits</span>
        <button className={`toggle${settings.autoResume ? " on" : ""}`} onClick={() => onChange({ ...settings, autoResume: !settings.autoResume })} />
      </label>
      <label className="rs-row">
        <span>Ask the agent to verify before finishing</span>
        <button
          className={`toggle${settings.requireVerification ? " on" : ""}`}
          onClick={() => onChange({ ...settings, requireVerification: !settings.requireVerification })}
        />
      </label>
      <label className="rs-row">
        <span>Parallel tasks</span>
        <input
          className="input rs-num"
          type="number"
          min={1}
          max={8}
          value={settings.concurrency}
          onChange={(e) => onChange({ ...settings, concurrency: Math.max(1, Math.min(8, num(e.target.value))) })}
        />
      </label>
      <div className="rs-note dim">Default budgets apply to new tasks. A task stops and asks before it exceeds any limit.</div>
    </div>
  );
}

export default Activity;