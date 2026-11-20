import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Monitor, Server, Trash2, Wifi, WifiOff } from 'lucide-react';

/**
 * BYOC nodes — bring your own compute.
 *
 * The panel creates one-time pairing codes and lists the machines that are
 * paired with this account. A node runs the agent sandbox on the user's own
 * hardware and connects out to the server; revoking one kills its session
 * and its token immediately.
 *
 * Nothing here ever shows a token: the server keeps only a hash of it.
 */

export interface ByocNodeRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  online: boolean;
  platform: string | null;
  arch: string | null;
  version: string | null;
  hostMode: boolean;
  desktop: boolean;
}

interface PairingCode {
  code: string;
  expiresAt: number;
  command: string;
}

const fmtTime = (ms: number | null): string => {
  if (!ms) return 'never';
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
};

export function ByocNodes() {
  const [nodes, setNodes] = useState<ByocNodeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/byoc/pair', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { nodes?: ByocNodeRow[] };
      setNodes(Array.isArray(body.nodes) ? body.nodes : []);
    } catch {
      setError('Could not load your nodes.');
      setNodes([]);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll while the panel is open so a node that comes online shows up.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const createCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/byoc/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PairingCode;
      setPairing(body);
    } catch {
      setError('Could not create a pairing code.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/byoc/pair?deviceId=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setError('Could not revoke that node.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  };

  const active = (nodes ?? []).filter((n) => !n.revokedAt);

  return (
    <div className="space-y-6" data-testid="byoc-nodes">
      <section>
        <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-white/40">
          Pair a machine
        </div>
        <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
          <p className="text-[11px] leading-relaxed text-white/40">
            Run the node on the machine that should host the agent sandbox. It connects out to
            this server — no ports have to be opened on your side.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void createCode()}
              disabled={busy}
              data-testid="byoc-create-code"
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5 text-xs text-white/80 transition hover:bg-white/15 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
              Create pairing code
            </button>
          </div>
          {pairing && (
            <div className="mt-3 rounded-xl bg-black/25 p-3 ring-1 ring-white/10" data-testid="byoc-pairing">
              <div className="flex items-center justify-between gap-2">
                <span data-testid="byoc-pairing-code" className="font-mono text-lg tracking-[0.3em] text-cyan-300">{pairing.code}</span>
                <button
                  onClick={() => void copy(pairing.command)}
                  className="flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-[10px] text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy command'}
                </button>
              </div>
              <code data-testid="byoc-pairing-command" className="mt-2 block break-all font-mono text-[10px] text-white/45">
                {pairing.command}
              </code>
              <p className="mt-1.5 text-[10px] text-white/30">
                One-time code · expires {fmtTime(pairing.expiresAt)}
              </p>
            </div>
          )}
          {error && <div className="mt-2 text-[10px] text-red-300/80">{error}</div>}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Your nodes</div>
          <span className="font-mono text-[10px] text-white/40">
            {active.length} paired · {active.filter((n) => n.online).length} online
          </span>
        </div>
        {nodes === null && (
          <div className="grid h-20 place-items-center text-xs text-white/35">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {nodes !== null && active.length === 0 && (
          <div
            data-testid="byoc-empty"
            className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40"
          >
            No nodes yet — create a pairing code and run it on your machine.
          </div>
        )}
        <div className="space-y-2">
          {active.map((node) => (
            <div
              key={node.id}
              data-testid="byoc-node-row"
              data-device-id={node.id}
              className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {node.online ? (
                    <Wifi className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5 shrink-0 text-white/25" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs text-white/85">{node.name}</div>
                    <div className="truncate font-mono text-[10px] text-white/35">
                      {node.platform ?? 'unknown'}
                      {node.arch ? ` · ${node.arch}` : ''}
                      {node.hostMode ? ' · host mode' : ' · container'}
                      {node.desktop ? ' · desktop' : ''}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    data-testid="byoc-node-online"
                    data-online={node.online ? 'true' : 'false'}
                    className={`font-mono text-[10px] ${
                      node.online ? 'text-emerald-300/80' : 'text-white/35'
                    }`}
                  >
                    {node.online ? 'online' : 'offline'}
                  </span>
                  <button
                    onClick={() => void revoke(node.id)}
                    disabled={busy}
                    aria-label={`Revoke ${node.name}`}
                    data-testid="byoc-revoke"
                    className="rounded-md p-1 text-white/30 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-white/30">
                <Monitor className="h-3 w-3" />
                paired {fmtTime(node.createdAt)} · last seen {fmtTime(node.lastSeenAt)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="text-[11px] leading-relaxed text-white/30">
        A node runs the sandbox inside a local container by default. It only touches your machine
        directly when you start it with <code className="font-mono">--host-mode</code> — the server
        can never switch that on.
      </p>
    </div>
  );
}
