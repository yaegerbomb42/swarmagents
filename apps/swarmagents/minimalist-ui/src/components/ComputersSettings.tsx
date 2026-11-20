'use client';

/**
 * Settings > Computers: pair and manage the user's own machines (BYOC).
 *
 * "Add a computer" creates a one-time pairing code and shows the one-line
 * install command for each OS. Paired machines list their online status, OS,
 * CPU/RAM, container-vs-host mode and last heartbeat, and can be renamed or
 * revoked. Everything is scoped to the signed-in account by the API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Laptop, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '../../../lib/client/thread';

export interface PairedComputer {
  id: string;
  name: string;
  os: 'linux' | 'macos' | 'windows';
  arch?: string;
  cpuCores?: number;
  memoryMb?: number;
  mode: 'container' | 'host';
  online: boolean;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
  version?: string;
}

interface Pairing {
  code: string;
  expiresAt: number;
  install: { linux: string; macos: string; windows: string };
}

type OSKey = 'linux' | 'macos' | 'windows';
const OS_TABS: Array<{ id: OSKey; label: string }> = [
  { id: 'linux', label: 'Linux' },
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
];

function osLabel(os: PairedComputer['os']): string {
  return os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
}

function machineSpec(computer: PairedComputer): string {
  const parts: string[] = [];
  if (computer.cpuCores) parts.push(`${computer.cpuCores} vCPU`);
  if (computer.memoryMb) parts.push(`${Math.max(1, Math.round(computer.memoryMb / 1024))} GB RAM`);
  if (computer.arch) parts.push(computer.arch);
  return parts.join(' · ') || 'Machine details pending';
}

function lastSeen(computer: PairedComputer): string {
  if (computer.online) return 'Online now';
  return computer.lastSeenAt ? `Last seen ${formatRelativeTime(computer.lastSeenAt)}` : 'Never seen';
}

export function ComputersSettings() {
  const [computers, setComputers] = useState<PairedComputer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<Pairing>();
  const [pairBusy, setPairBusy] = useState(false);
  const [osTab, setOsTab] = useState<OSKey>('linux');
  const [copied, setCopied] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [nameDraft, setNameDraft] = useState('');
  const [revokingId, setRevokingId] = useState<string>();
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/computers', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as { computers?: PairedComputer[]; error?: string } | null;
      if (!aliveRef.current) return;
      if (!res.ok) {
        setError(body?.error ?? `Could not load computers (HTTP ${res.status}).`);
        return;
      }
      setComputers(Array.isArray(body?.computers) ? body!.computers! : []);
      setError(undefined);
    } catch (err) {
      if (aliveRef.current) setError((err as Error).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const startPairing = useCallback(async () => {
    setPairBusy(true);
    setError(undefined);
    try {
      const res = await fetch('/api/computers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => null)) as Pairing & { error?: string } | null;
      if (!res.ok || !body?.code || !body.install) {
        setError(body?.error ?? `Could not create a pairing code (HTTP ${res.status}).`);
        return;
      }
      setPairing({ code: body.code, expiresAt: body.expiresAt, install: body.install });
      setCopied(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPairBusy(false);
    }
  }, []);

  const copyCommand = useCallback(async () => {
    if (!pairing) return;
    const text = pairing.install[osTab];
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked outside a secure context; the command is
      // still selectable on screen.
    }
  }, [pairing, osTab]);

  const saveName = useCallback(async (id: string) => {
    const name = nameDraft.trim();
    if (!name) return;
    try {
      const res = await fetch(`/api/computers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as { computer?: PairedComputer; error?: string } | null;
      if (!res.ok || !body?.computer) {
        setError(body?.error ?? `Could not rename the computer (HTTP ${res.status}).`);
        return;
      }
      setComputers((list) => list.map((item) => (item.id === id ? body.computer! : item)));
      setRenamingId(undefined);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [nameDraft]);

  const revoke = useCallback(async (computer: PairedComputer) => {
    if (!window.confirm(`Revoke "${computer.name}"? Runs on it will stop and its token stops working immediately.`)) return;
    setRevokingId(computer.id);
    try {
      const res = await fetch(`/api/computers/${encodeURIComponent(computer.id)}`, { method: 'DELETE' });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `Could not revoke the computer (HTTP ${res.status}).`);
        return;
      }
      setComputers((list) => list.filter((item) => item.id !== computer.id));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRevokingId(undefined);
    }
  }, []);

  const onlineCount = useMemo(() => computers.filter((c) => c.online).length, [computers]);

  return (
    <div className="space-y-4" data-testid="computers-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white/90">Your computers</div>
          <p className="mt-0.5 text-[11.5px] leading-5 text-white/50">
            Run agents on your own machine instead of the cloud pool. The node keeps the computer online; revoke it any time.
          </p>
        </div>
        <button
          type="button"
          data-testid="add-computer"
          onClick={() => void startPairing()}
          disabled={pairBusy}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cyan-400 px-3 text-[12px] font-medium text-black transition hover:bg-cyan-300 disabled:opacity-50"
        >
          {pairBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add a computer
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-[12px] text-rose-200">
          {error}
        </div>
      )}

      {pairing && (
        <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] p-3" data-testid="pairing-panel">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-medium text-cyan-100">Pair a new computer</div>
            <button type="button" onClick={() => setPairing(undefined)} className="text-[11px] text-white/40 hover:text-white/70">Dismiss</button>
          </div>
          <p className="mt-1 text-[11.5px] leading-5 text-white/55">
            Run the one-line command on that machine. It pairs with this code, then keeps the computer online.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Pairing code</div>
            <code data-testid="pairing-code" className="rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-[15px] tracking-[0.18em] text-white">
              {pairing.code}
            </code>
            <span className="text-[10.5px] text-white/35">
              expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div role="tablist" aria-label="Install command operating system" className="mt-3 flex gap-1 rounded-full bg-white/5 p-0.5 ring-1 ring-white/10">
            {OS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={osTab === tab.id}
                data-testid={`install-os-${tab.id}`}
                onClick={() => { setOsTab(tab.id); setCopied(false); }}
                className={`flex-1 rounded-full px-2 py-1 text-[11px] transition ${osTab === tab.id ? 'bg-cyan-400 text-black' : 'text-white/60 hover:text-white/90'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-start gap-2">
            <code data-testid="install-command" className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-white/10 bg-black/50 px-2.5 py-2 font-mono text-[10.5px] leading-5 text-zinc-300">
              {pairing.install[osTab]}
            </code>
            <button
              type="button"
              onClick={() => void copyCommand()}
              aria-label="Copy install command"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/10 text-white/60 hover:bg-white/10 hover:text-white"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2 text-[11px] text-white/40">
          <span>
            {computers.length === 0 ? 'No computers paired' : `${computers.length} paired · ${onlineCount} online`}
          </span>
          <button type="button" onClick={() => void load()} aria-label="Refresh computers" className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white/80">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12px] text-white/40"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your computers…</div>
        ) : computers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <Laptop className="h-5 w-5 text-white/25" />
            <div className="text-[12px] text-white/50">Pair a computer to run agents on your own hardware.</div>
            <div className="text-[11px] text-white/30">Click “Add a computer” to get a code and an install command.</div>
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {computers.map((computer) => (
              <li key={computer.id} data-testid="computer-row" data-computer-id={computer.id} className="px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span
                    data-testid="computer-online"
                    data-online={computer.online ? 'true' : 'false'}
                    className={`h-2 w-2 shrink-0 rounded-full ${computer.online ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                    aria-label={computer.online ? 'online' : 'offline'}
                  />
                  <div className="min-w-0 flex-1">
                    {renamingId === computer.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void saveName(computer.id); if (e.key === 'Escape') setRenamingId(undefined); }}
                          aria-label="Computer name"
                          maxLength={60}
                          className="h-7 min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 text-[12px] text-white focus:border-cyan-400/60 focus:outline-none"
                        />
                        <button type="button" onClick={() => void saveName(computer.id)} className="rounded px-1.5 py-1 text-[11px] text-emerald-300 hover:bg-white/10">Save</button>
                        <button type="button" onClick={() => setRenamingId(undefined)} className="rounded px-1.5 py-1 text-[11px] text-white/50 hover:bg-white/10">Cancel</button>
                      </div>
                    ) : (
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] text-white/90">{computer.name}</span>
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide ${computer.online ? 'border-emerald-400/30 text-emerald-300' : 'border-white/10 text-white/40'}`}>
                          {computer.online ? 'online' : 'offline'}
                        </span>
                        <span className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-white/40">{computer.mode}</span>
                      </div>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/40">
                      <span>{osLabel(computer.os)}</span><span>·</span>
                      <span>{machineSpec(computer)}</span><span>·</span>
                      <span>{lastSeen(computer)}</span>
                      {computer.version && <><span>·</span><span>node {computer.version}</span></>}
                    </div>
                  </div>
                  {renamingId !== computer.id && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-testid="rename-computer"
                        onClick={() => { setRenamingId(computer.id); setNameDraft(computer.name); }}
                        className="rounded px-1.5 py-1 text-[11px] text-white/45 hover:bg-white/10 hover:text-white/80"
                      >Rename</button>
                      <button
                        type="button"
                        data-testid="revoke-computer"
                        onClick={() => void revoke(computer)}
                        disabled={revokingId === computer.id}
                        className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-rose-300/80 hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-40"
                      >
                        {revokingId === computer.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        Revoke
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
