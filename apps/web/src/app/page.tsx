'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { LogIn, Plus, Settings } from 'lucide-react';
import { PromptBar } from '@/components/console/PromptBar';
import { ProviderPill, type PillBackend } from '@/components/console/ProviderPill';
import { TelemetryFeed } from '@/components/console/TelemetryFeed';
import { TeamPanel } from '@/components/team/TeamPanel';
import { useTeamRun } from '@/hooks/useTeamRun';

/**
 * The home console: one centered prompt bar, a provider pill, and a live
 * telemetry feed below it. No marketing hero, no marquees, no tickers,
 * no auth gate — arriving at / is immediately the command interface.
 * Sign-in still exists for /command and the rest of the app; it is one
 * small link here, not a roadblock.
 */
export default function HomeConsole() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [provider, setProvider] = useState<PillBackend | null>(null);
  const [setupHint, setSetupHint] = useState<PillBackend | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [mode, setMode] = useState<'solo' | 'team'>('solo');
  const [teamRunId, setTeamRunId] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const { run: teamRun, connected: teamConnected } = useTeamRun(teamRunId);
  const teamActive = Boolean(teamRun && ['planning', 'running', 'reviewing'].includes(teamRun.status));
  const busy = running || teamActive;

  // Resume the last task if the server still has it (the feed drops back
  // to the hero on its own if the record is gone).
  useEffect(() => {
    try {
      const last = localStorage.getItem('swarm.active');
      if (last) setTaskId(last);
      const team = localStorage.getItem('swarm.team');
      if (team) {
        setTeamRunId(team);
        setMode('team');
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (teamRun && ['completed', 'failed', 'cancelled'].includes(teamRun.status)) setRunning(false);
  }, [teamRun]);

  const persistTask = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem('swarm.active', id);
      else localStorage.removeItem('swarm.active');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const persistTeam = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem('swarm.team', id);
      else localStorage.removeItem('swarm.team');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const dispatchTeam = useCallback(
    async (text: string) => {
      setTeamError(null);
      setDispatchError(null);
      try {
        const res = await fetch('/api/team', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(() => {
              try {
                const t = localStorage.getItem('swarm.harnessToken');
                return t ? { Authorization: `Bearer ${t}` } : {};
              } catch {
                return {};
              }
            })(),
          },
          body: JSON.stringify({ prompt: text, userId: 'local' }),
        });
        const data = (await res.json()) as { ok?: boolean; runId?: string; error?: string };
        if (!res.ok || !data.ok || !data.runId) {
          setTeamError(data.error || 'Team dispatch failed — no run was started.');
          return;
        }
        setTeamRunId(data.runId);
        setTaskTitle(text.slice(0, 80));
        setRunning(true);
        persistTeam(data.runId);
      } catch (err) {
        setTeamError(err instanceof Error ? err.message : 'Team dispatch failed.');
      }
    },
    [persistTeam],
  );

  const dispatch = useCallback(
    async (text: string) => {
      setDispatchError(null);
      setSetupHint(null);
      if (mode === 'team') {
        await dispatchTeam(text);
        return;
      }
      try {
        const res = await fetch('/api/harness/task', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Same token the /console page stores when the server requires one.
            ...(() => {
              try {
                const t = localStorage.getItem('swarm.harnessToken');
                return t ? { Authorization: `Bearer ${t}` } : {};
              } catch {
                return {};
              }
            })(),
          },
          body: JSON.stringify({
            prompt: text,
            provider: provider?.type ?? undefined,
            model: provider?.model ?? undefined,
          }),
        });
        const data = (await res.json()) as { ok?: boolean; taskId?: string; error?: string };
        if (!res.ok || !data.ok || !data.taskId) {
          setDispatchError(data.error || 'Dispatch failed — the harness did not accept the mission.');
          return;
        }
        setTaskId(data.taskId);
        setTaskTitle(text.slice(0, 80));
        setRunning(true);
        persistTask(data.taskId);
      } catch (err) {
        setDispatchError(err instanceof Error ? err.message : 'Dispatch failed.');
      }
    },
    [provider, persistTask, mode, dispatchTeam],
  );

  const onTaskEnd = useCallback(() => setRunning(false), []);
  const onTaskGone = useCallback(() => {
    setTaskId(null);
    setTaskTitle(null);
    setRunning(false);
    persistTask(null);
  }, [persistTask]);

  const newMission = useCallback(() => {
    setTaskId(null);
    setTeamRunId(null);
    setTaskTitle(null);
    setRunning(false);
    setDispatchError(null);
    setTeamError(null);
    persistTask(null);
    persistTeam(null);
  }, [persistTask, persistTeam]);

  return (
    <div className="min-h-[100svh] bg-bg-0 text-fg-1">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/brand/swarm-icon-fast.gif"
            alt="SwarmAgents logo"
            width={26}
            height={26}
            className="rounded-sm"
            unoptimized
          />
          <span className="font-mono text-[15px] font-semibold tracking-[-0.03em] text-fg-1">
            swarmagents.codes
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-meta text-fg-3">
          <span className="hidden rounded-full border border-line-2 px-2.5 py-1 text-micro text-fg-2 sm:inline">
            Console
          </span>
          {taskId || teamRunId ? (
            <button
              type="button"
              onClick={newMission}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-white/[0.04] hover:text-fg-1"
            >
              <Plus className="h-3.5 w-3.5" />
              New mission
            </button>
          ) : null}
          <Link
            href="/command"
            className="rounded-md px-2 py-1.5 hover:bg-white/[0.04] hover:text-fg-1"
          >
            Full console
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-white/[0.04] hover:text-fg-1"
            aria-label="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Settings</span>
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-white/[0.04] hover:text-fg-1"
          >
            <LogIn className="h-3.5 w-3.5" />
            Sign in
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col items-center px-5 pb-16">
        {!taskId && !teamRunId ? (
          <div className="pb-8 pt-14 text-center md:pt-20">
            <h1 className="text-[clamp(2rem,6vw,3.25rem)] font-semibold leading-[1.1] tracking-[-0.04em] text-fg-1">
              What should we get done?
            </h1>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-fg-3">
              Dispatch a mission to the swarm. Its thoughts, tool calls, and
              timings stream below — no sign-in required.
            </p>
          </div>
        ) : (
          <div className="w-full pb-4 pt-6">
            <p className="truncate font-mono text-meta text-fg-3" title={taskTitle ?? undefined}>
              {running ? 'Running — ' : 'Mission — '}
              {taskTitle ?? taskId}
            </p>
          </div>
        )}

        <PromptBar running={busy} onSend={(text) => void dispatch(text)} />

        <div
          role="group"
          aria-label="Run mode"
          className="mt-3 inline-flex items-center gap-0.5 rounded-full border border-line-2 bg-bg-1 p-0.5"
        >
          {(['solo', 'team'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`mode-${m}`}
              onClick={() => {
                setMode(m);
                setDispatchError(null);
                setTeamError(null);
              }}
              className={`rounded-full px-3 py-1 font-mono text-micro transition-colors duration-fast ${
                mode === m ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:text-fg-1'
              }`}
            >
              {m === 'solo' ? 'Solo' : 'Team'}
            </button>
          ))}
        </div>

        <div className="mt-3 w-full">
          <ProviderPill
            selected={provider?.type ?? null}
            onSelect={setProvider}
            onNeedSetup={setSetupHint}
          />
        </div>

        {setupHint ? (
          <p className="mt-3 text-center text-meta text-fg-3">
            {setupHint.label} isn&apos;t configured yet —{' '}
            <Link href="/settings" className="text-accent hover:text-accent-strong">
              add its key in Settings
            </Link>{' '}
            (it uses the {setupHint.model} template).
          </p>
        ) : null}

        {dispatchError ? (
          <p role="alert" className="mt-3 text-center text-meta text-st-failed">
            {dispatchError}
          </p>
        ) : null}

        {mode === 'team' ? (
          <div className="mt-5 w-full">
            {teamRun ? (
              <TeamPanel run={teamRun} />
            ) : (
              <p className="rounded-r-md border border-line-2 bg-bg-1 p-3 text-center text-meta text-fg-3">
                One prompt spawns a planner, 2–4 sub-agents in isolated folders, and a
                reviewer that merges or sends work back.
              </p>
            )}
            {teamError ? (
              <p role="alert" className="mt-2 text-center text-meta text-st-failed">
                {teamError}
              </p>
            ) : null}
            {teamRun && !teamConnected ? (
              <p className="mt-2 text-center font-mono text-micro text-fg-4">
                reconnecting to the team stream…
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 w-full">
            <TelemetryFeed taskId={taskId} running={running} onTaskEnd={onTaskEnd} onTaskGone={onTaskGone} />
          </div>
        )}

        <footer className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center font-mono text-micro text-fg-4">
          <span>home console · runs without sign-in</span>
          <Link href="/command" className="hover:text-fg-3">
            full console →
          </Link>
          <Link href="/login" className="hover:text-fg-3">
            sign in for saved missions →
          </Link>
        </footer>
      </main>
    </div>
  );
}
