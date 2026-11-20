'use client';

/**
 * Compute picker for the composer.
 *
 * Lists "SwarmAgents cloud" plus the user's paired computers, with online
 * status. The choice is remembered per project (server-side
 * `project.computeTarget` when a project is active, plus a localStorage
 * fallback). Free-tier accounts default to a paired computer when the cloud VM
 * pool is full and a computer is online.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Laptop, Loader2 } from 'lucide-react';
import type { PairedComputer } from './ComputersSettings';

interface ComputeResponse {
  computers?: PairedComputer[];
  cloud?: { capacity: number; inUse: number; full: boolean };
  freeTier?: boolean;
  defaultTarget?: string;
  projectTarget?: string;
}

export interface ComputeOptions {
  loaded: boolean;
  computers: PairedComputer[];
  cloud: { capacity: number; inUse: number; full: boolean };
  freeTier: boolean;
  defaultTarget: string;
  /** Current choice ("cloud" or "computer:<id>"). */
  target: string;
  setTarget: (target: string) => void;
  /** True when a free-tier user got BYOC as the default because the pool is full. */
  byocDefault: boolean;
}

const FALLBACK_CLOUD = { capacity: 0, inUse: 0, full: false };

export function targetForComputer(id: string): string {
  return `computer:${id}`;
}

export function computerIdFromTarget(target: string): string | undefined {
  const match = /^computer:(cmp_[a-f0-9-]{8,64})$/i.exec(target.trim());
  return match ? match[1] : undefined;
}

function validTarget(target: string, computers: readonly PairedComputer[]): boolean {
  if (!target || target === 'cloud') return true;
  const id = computerIdFromTarget(target);
  return Boolean(id && computers.some((computer) => computer.id === id));
}

function rememberedFor(projectId?: string): string | undefined {
  try {
    return window.localStorage.getItem(`ac.computeTarget:${projectId || 'none'}`) || undefined;
  } catch {
    return undefined;
  }
}

export function useComputeOptions(projectId?: string): ComputeOptions {
  const [computers, setComputers] = useState<PairedComputer[]>([]);
  const [cloud, setCloud] = useState(FALLBACK_CLOUD);
  const [freeTier, setFreeTier] = useState(false);
  const [defaultTarget, setDefaultTarget] = useState('cloud');
  const [loaded, setLoaded] = useState(false);
  const [target, setTargetState] = useState('');
  const keyRef = useRef(projectId ?? '');
  const initializedRef = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    const key = projectId ?? '';
    try {
      const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const res = await fetch(`/api/runtime/compute${params}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as ComputeResponse | null;
      if (!body || key !== keyRef.current) return;
      if (Array.isArray(body.computers)) setComputers(body.computers);
      if (body.cloud) setCloud(body.cloud);
      setFreeTier(body.freeTier === true);
      setDefaultTarget(typeof body.defaultTarget === 'string' ? body.defaultTarget : 'cloud');
      setLoaded(true);
      // First load for this project: choose the remembered target, then the
      // server default. A target whose computer was revoked falls back.
      if (initializedRef.current !== key) {
        const list = Array.isArray(body.computers) ? body.computers : [];
        const remembered = rememberedFor(projectId) ?? body.projectTarget;
        const chosen = remembered && validTarget(remembered, list) ? remembered : (body.defaultTarget ?? 'cloud');
        initializedRef.current = key;
        setTargetState(chosen);
      }
    } catch {
      // Keep the previous options; the picker still works with cloud.
    }
  }, [projectId]);

  useEffect(() => {
    keyRef.current = projectId ?? '';
    initializedRef.current = undefined;
    setTargetState('');
    setLoaded(false);
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [projectId, load]);

  const setTarget = useCallback((next: string) => {
    setTargetState(next);
    try {
      window.localStorage.setItem(`ac.computeTarget:${projectId || 'none'}`, next);
    } catch {
      // Storage may be unavailable; the choice still applies to this session.
    }
    if (projectId) {
      void fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computeTarget: next }),
      }).catch(() => null);
    }
  }, [projectId]);

  const byocDefault =
    freeTier && cloud.full && defaultTarget.startsWith('computer:') && computers.some((c) => c.online);

  return { loaded, computers, cloud, freeTier, defaultTarget, target, setTarget, byocDefault };
}

export function ComputePicker({
  options,
  busy,
  testId = 'compute-picker',
}: {
  options: ComputeOptions;
  busy?: boolean;
  testId?: string;
}) {
  const selected = options.target || 'cloud';
  const selectedComputer = options.computers.find((computer) => targetForComputer(computer.id) === selected);
  const onlineComputers = options.computers.filter((computer) => computer.online);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="hidden text-white/40 sm:inline" aria-hidden>
        {selectedComputer ? <Laptop className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
      </span>
      <label className="sr-only" htmlFor={`${testId}-select`}>Compute for this run</label>
      <select
        id={`${testId}-select`}
        data-testid={testId}
        value={selected}
        disabled={busy}
        onChange={(event) => options.setTarget(event.target.value)}
        title={
          options.byocDefault
            ? 'The cloud pool is full, so this free-tier account defaults to your own computer.'
            : 'Choose where this run executes'
        }
        className="h-7 max-w-[220px] min-w-0 truncate rounded-md border border-white/10 bg-[#141418] px-2 text-[11px] text-zinc-200 disabled:opacity-50"
      >
        <option value="cloud">SwarmAgents cloud{options.cloud.full ? ' · pool full' : ''}</option>
        {options.computers.map((computer) => (
          <option key={computer.id} value={targetForComputer(computer.id)} disabled={!computer.online}>
            {computer.name} · {computer.online ? 'online' : 'offline'}
          </option>
        ))}
      </select>
      {!options.loaded && <Loader2 className="h-3 w-3 animate-spin text-white/30" aria-hidden />}
      {options.byocDefault && options.target.startsWith('computer:') && (
        <span
          data-testid="byoc-default"
          className="hidden shrink-0 rounded border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-cyan-200 sm:inline"
          title={`Cloud pool full (${options.cloud.inUse}/${options.cloud.capacity}) — running on your computer by default.`}
        >
          BYOC
        </span>
      )}
      {selectedComputer && !selectedComputer.online && (
        <span className="hidden shrink-0 text-[10px] text-amber-300/80 sm:inline">offline</span>
      )}
      {selected === 'cloud' && onlineComputers.length > 0 && options.freeTier && options.cloud.full && (
        <span className="hidden shrink-0 text-[10px] text-white/30 sm:inline">pool full</span>
      )}
    </div>
  );
}
