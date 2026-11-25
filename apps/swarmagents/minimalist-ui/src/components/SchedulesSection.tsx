"use client";

/**
 * SchedulesSection — the minimal "Schedules" management block on the Agent
 * tab of Settings.
 *
 * Lists the user's recurring autonomous runs (name, cadence, next tick,
 * paused state) with pause/resume and delete, plus a small create form
 * (name, prompt, interval in minutes). The webhook secret is shown exactly
 * once, right after creation — the API never returns it again.
 *
 * Talks to /api/runtime/schedules with plain fetch; the session middleware
 * attaches the user, so no credentials live in this component.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Notice } from "./ui";

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  hasWebhookSecret: boolean;
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes === 60) return "every hour";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 24 ? "every day" : `every ${hours} hours`;
  }
  return `every ${minutes} min`;
}

export function formatNextRun(nextRunAt: number, nowMs: number = Date.now()): string {
  const diffMs = nextRunAt - nowMs;
  if (diffMs <= 0) return "due now";
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `in ${diffMin} min`;
  if (diffMin < 24 * 60) {
    const hours = Math.floor(diffMin / 60);
    const rest = diffMin % 60;
    return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  }
  return new Date(nextRunAt).toLocaleString();
}

export function SchedulesList({
  schedules,
  busyId,
  confirmDeleteId,
  onToggle,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  schedules: ScheduleView[];
  busyId: string | null;
  confirmDeleteId: string | null;
  onToggle: (schedule: ScheduleView) => void;
  onDelete: (schedule: ScheduleView) => void;
  onConfirmDelete: (schedule: ScheduleView) => void;
  onCancelDelete: () => void;
}) {
  if (schedules.length === 0) {
    return <p className="text-[13px] text-sa-fg3">No schedules yet. Add one below and it runs on its own.</p>;
  }
  return (
    <ul className="space-y-2">
      {schedules.map((schedule) => (
        <li
          key={schedule.id}
          data-testid="schedule-row"
          className="rounded-xl border border-sa-line bg-sa-raised px-3 py-2.5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-sa-fg">{schedule.name}</span>
                {!schedule.enabled && (
                  <span className="shrink-0 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/20">
                    Paused
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[13px] text-sa-fg2">{schedule.prompt}</p>
              <p className="mt-0.5 text-[12px] text-sa-fg3">
                {formatInterval(schedule.intervalMinutes)}
                {" · "}
                {schedule.enabled ? `next run ${formatNextRun(schedule.nextRunAt)}` : "not scheduled while paused"}
                {schedule.lastRunAt ? ` · last run ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                loading={busyId === schedule.id}
                onClick={() => onToggle(schedule)}
                data-testid="schedule-toggle"
              >
                {schedule.enabled ? "Pause" : "Resume"}
              </Button>
              {confirmDeleteId === schedule.id ? (
                <>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busyId === schedule.id}
                    onClick={() => onConfirmDelete(schedule)}
                    data-testid="schedule-delete-confirm"
                  >
                    Delete?
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCancelDelete} data-testid="schedule-delete-cancel">
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDelete(schedule)}
                  data-testid="schedule-delete"
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SchedulesSection() {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [interval, setInterval] = useState("60");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/runtime/schedules", { cache: "no-store" });
      if (!res.ok) {
        setError("Couldn't load schedules.");
        return;
      }
      const body = (await res.json()) as { schedules?: ScheduleView[] };
      setSchedules(Array.isArray(body.schedules) ? body.schedules : []);
      setError(null);
    } catch {
      setError("Couldn't load schedules.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const intervalMinutes = Number(interval);
    if (!name.trim() || !prompt.trim() || !Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
      setError("Give the schedule a name, a prompt, and an interval of at least 5 minutes.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim(), intervalMinutes }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as {
        schedule?: ScheduleView;
        webhookSecret?: string;
        error?: string;
      } | null;
      if (!res.ok || !body?.schedule) {
        setError(body?.error ?? "Couldn't create the schedule.");
        return;
      }
      setSchedules((list) => [...(list ?? []), body.schedule as ScheduleView]);
      setCreatedSecret(typeof body.webhookSecret === "string" ? body.webhookSecret : null);
      setCreatedName(body.schedule.name);
      setName("");
      setPrompt("");
      setInterval("60");
    } catch {
      setError("Couldn't create the schedule.");
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (schedule: ScheduleView) => {
    setBusyId(schedule.id);
    setError(null);
    try {
      const res = await fetch(`/api/runtime/schedules?id=${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedule.enabled }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { schedule?: ScheduleView; error?: string } | null;
      if (!res.ok || !body?.schedule) {
        setError(body?.error ?? "Couldn't update the schedule.");
        return;
      }
      setSchedules((list) => (list ?? []).map((entry) => (entry.id === schedule.id ? body.schedule as ScheduleView : entry)));
    } catch {
      setError("Couldn't update the schedule.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (schedule: ScheduleView) => {
    setBusyId(schedule.id);
    setError(null);
    try {
      const res = await fetch(`/api/runtime/schedules?id=${encodeURIComponent(schedule.id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Couldn't delete the schedule.");
        return;
      }
      setSchedules((list) => (list ?? []).filter((entry) => entry.id !== schedule.id));
      setConfirmDeleteId(null);
    } catch {
      setError("Couldn't delete the schedule.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-2" data-testid="schedules-section">
      <div>
        <h3 className="text-sm font-medium text-sa-fg">Schedules</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-sa-fg2">
          Recurring autonomous runs. Each schedule fires its prompt on its own cadence (at least every 5 minutes,
          up to 20 per account) and pauses when you pause it.
        </p>
      </div>
      {error && (
        <Notice tone="err" title={error} testId="schedules-error" />
      )}
      {createdSecret && (
        <Notice tone="info" title={`Webhook secret for “${createdName}”`} testId="schedules-secret">
          Save this secret — it is shown once and never again. Trigger the schedule any time with
          {" POST /api/runtime/schedules/hooks/<you>/<id>"} and the secret as a Bearer token.
          <span className="mt-1 block break-all font-mono text-[12px]">{createdSecret}</span>
        </Notice>
      )}
      {schedules === null ? (
        <p className="text-[13px] text-sa-fg3">Loading schedules…</p>
      ) : (
        <SchedulesList
          schedules={schedules}
          busyId={busyId}
          confirmDeleteId={confirmDeleteId}
          onToggle={(schedule) => void toggle(schedule)}
          onDelete={(schedule) => setConfirmDeleteId(schedule.id)}
          onConfirmDelete={(schedule) => void remove(schedule)}
          onCancelDelete={() => setConfirmDeleteId(null)}
        />
      )}
      <div className="space-y-2 rounded-xl border border-sa-line bg-sa-raised p-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Schedule name"
          aria-label="Schedule name"
          data-testid="schedule-create-name"
          maxLength={120}
          className="w-full rounded-lg border border-sa-line-strong bg-sa-bg px-3 py-2 text-sm text-sa-fg outline-none placeholder:text-sa-fg3"
        />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should the agent do each time? (e.g. “Summarize what changed overnight.”)"
          aria-label="Schedule prompt"
          data-testid="schedule-create-prompt"
          rows={2}
          maxLength={8000}
          className="w-full resize-y rounded-lg border border-sa-line-strong bg-sa-bg px-3 py-2 text-sm leading-relaxed text-sa-fg outline-none placeholder:text-sa-fg3"
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-sa-fg2">
            Every
            <input
              value={interval}
              onChange={(event) => setInterval(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              aria-label="Interval in minutes"
              data-testid="schedule-create-interval"
              className="w-20 rounded-lg border border-sa-line-strong bg-sa-bg px-2 py-1.5 text-sm text-sa-fg outline-none"
            />
            minutes
          </label>
          <Button
            size="sm"
            loading={creating}
            onClick={() => void create()}
            data-testid="schedule-create"
            className="ml-auto"
          >
            Add schedule
          </Button>
        </div>
      </div>
    </section>
  );
}
