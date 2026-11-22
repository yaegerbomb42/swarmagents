import { useCallback, useEffect, useState } from "react";

type Proposal = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
};

type GardenerState = {
  enabled: boolean;
  maxDifficulty: "easy" | "medium" | "hard";
  proposals: Proposal[];
  idleMs: number;
  inWindow: boolean;
};

const DIFFICULTIES: Array<"easy" | "medium" | "hard"> = ["easy", "medium", "hard"];

export function AutopilotIdle() {
  const [state, setState] = useState<GardenerState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/gardener");
    if (!res.ok) {
      setError("Autopilot status unavailable");
      return;
    }
    setState(await res.json());
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/gardener", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError("Autopilot update failed");
      return;
    }
    await load();
  };

  const pending = state?.proposals.filter((p) => p.status === "awaiting_approval") ?? [];

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-white/90">Autopilot idle mode</div>
          <p className="mt-1 text-[11px] text-white/45">
            While this VM is inside the {state ? Math.round(state.idleMs / 60_000) : 30} minute window before
            hibernation, surplus free or local quota is used to propose tests and board tasks. Nothing merges
            until you approve.
          </p>
        </div>
        <button
          type="button"
          className={`shrink-0 rounded-full px-3 py-1 text-xs ${state?.enabled ? "bg-white text-black" : "bg-white/10 text-white/80"}`}
          onClick={() => void post({ action: "setEnabled", enabled: !state?.enabled })}
        >
          {state?.enabled ? "On" : "Off"}
        </button>
      </div>
      {state?.enabled && (
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/40">
            Max difficulty{state.inWindow ? " · idle window open" : " · waiting for idle window"}
          </span>
          {DIFFICULTIES.map((level) => (
            <button
              key={level}
              type="button"
              className={`rounded-full px-2 py-0.5 text-[10px] capitalize ${
                state.maxDifficulty === level ? "bg-white text-black" : "bg-white/10 text-white/80"
              }`}
              onClick={() => void post({ action: "setDifficulty", maxDifficulty: level })}
            >
              {level}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-[11px] text-amber-200/80">{error}</p>}
      <ul className="mt-3 space-y-2">
        {pending.map((proposal) => (
          <li key={proposal.id} className="rounded-xl bg-black/30 px-2.5 py-2">
            <div className="text-xs text-white/85">{proposal.title}</div>
            <p className="mt-1 text-[11px] text-white/45">{proposal.summary}</p>
            <button
              type="button"
              className="mt-2 rounded-full bg-white px-2.5 py-1 text-[11px] text-black"
              onClick={() => void post({ action: "approve", proposalId: proposal.id })}
            >
              Approve
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
