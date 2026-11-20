/**
 * Race / hedge telemetry model.
 *
 * Surfaces the router's hedging and racing in a form the UI can render live —
 * e.g. "Anthropic stalled at 1.5s → hedged to OpenAI → won in 820ms, saved
 * $0.04". The router and arena runner produce the participant observations;
 * this module stays dependency-free (pure) so both the server and the browser
 * UI can import it.
 */

export type RaceMode = "hedged" | "simultaneous";
export type RaceParticipantStatus = "winner" | "aborted" | "failed";

export interface RaceParticipant {
  provider: string;
  model?: string;
  /** ms from call start to the first output token (absent if none arrived). */
  firstTokenMs?: number;
  /** Total latency ms (winner: full completion; others: until aborted/failed). */
  latencyMs: number;
  costUsd?: number;
  status: RaceParticipantStatus;
}

export interface RaceReport {
  mode: RaceMode;
  /** How long the primary waited before a hedge contender started (ms). */
  hedgeDelayMs: number;
  /** True when a hedge actually fired because the primary stalled. */
  hedgeFired: boolean;
  participants: RaceParticipant[];
  winner?: RaceParticipant;
  /** ms saved vs. waiting on the slowest contender (winner vs. worst). */
  latencySavedMs?: number;
  /** Optional dollar framing (caller-supplied; omitted when not meaningful). */
  savedUsd?: number;
}

/** Order participants by first-token arrival, then total latency. */
export function sortParticipants(participants: readonly RaceParticipant[]): RaceParticipant[] {
  return [...participants].sort(
    (a, b) =>
      (a.firstTokenMs ?? a.latencyMs) - (b.firstTokenMs ?? b.latencyMs) ||
      a.latencyMs - b.latencyMs,
  );
}

/**
 * Assemble a RaceReport from the observed participants. The winner is the
 * participant that produced a first token (or finished) earliest; a hedge is
 * considered to have fired when the winning contender arrived only after
 * `hedgeDelayMs` — i.e. the primary stalled long enough to trigger the hedge.
 */
export function buildRaceReport(
  mode: RaceMode,
  participants: readonly RaceParticipant[],
  hedgeDelayMs: number,
): RaceReport {
  const sorted = sortParticipants(participants);
  const winner = sorted.find((p) => p.status === "winner") ?? sorted[0];
  // A hedge fires when the primary contender stalls past the delay, i.e. any
  // participant (the aborted primary, or a hedge that also ran late) took
  // longer than the hedge trigger threshold.
  const hedgeFired =
    mode === "hedged" && sorted.some((p) => (p.firstTokenMs ?? p.latencyMs) > hedgeDelayMs);
  const worst = sorted[sorted.length - 1];
  const latencySavedMs =
    winner && worst && winner !== worst
      ? Math.max(0, (worst.firstTokenMs ?? worst.latencyMs) - (winner.firstTokenMs ?? winner.latencyMs))
      : undefined;
  return {
    mode,
    hedgeDelayMs,
    hedgeFired,
    participants: sorted,
    winner,
    latencySavedMs,
  };
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Human-readable one-line summary of a race, e.g.
 *   "Anthropic stalled at 1.5s → hedged to OpenAI → won in 820ms, saved $0.04"
 * Degrades gracefully when the data is thin (no hedge, no savings).
 */
export function formatHedgeLine(report: RaceReport): string {
  const { participants, winner } = report;
  if (participants.length === 0) return "No race data.";

  // In a hedged race the narrative subject is the primary that stalled — the
  // slowest participant, not the winner that crossed first. In simultaneous
  // mode the subject is simply the first (speediest) contender.
  const stall = report.mode === "hedged"
    ? [...participants].sort(
        (a, b) =>
          ((b.firstTokenMs ?? b.latencyMs) as number) - ((a.firstTokenMs ?? a.latencyMs) as number),
      )[0]
    : undefined;
  const isStalled = Boolean(
    stall && (stall.firstTokenMs ?? stall.latencyMs) > report.hedgeDelayMs,
  );
  const primary = isStalled ? stall : participants[0];

  const pieces: string[] = [];
  if (report.mode === "hedged") {
    if (primary && isStalled) {
      pieces.push(`${primary.provider} stalled at ${fmtMs(primary.firstTokenMs ?? primary.latencyMs)}`);
      pieces.push("hedged");
    } else if (primary) {
      pieces.push(`${primary.provider} started → hedged`);
    }
  } else {
    pieces.push(`raced ${participants.map((p) => p.provider).join(" + ")}`);
  }

  if (winner) {
    const wonIn = winner.latencyMs !== undefined ? ` in ${fmtMs(winner.latencyMs)}` : "";
    pieces.push(`${winner.provider}${winner.model ? ` (${winner.model})` : ""} won${wonIn}`);
  }

  const extras: string[] = [];
  if (report.latencySavedMs !== undefined && report.latencySavedMs > 0) {
    extras.push(`saved ${fmtMs(report.latencySavedMs)}`);
  }
  if (report.savedUsd !== undefined && report.savedUsd > 0) {
    extras.push(`saved ${fmtUsd(report.savedUsd)}`);
  }
  if (extras.length > 0) pieces.push(extras.join(", "));

  return pieces.join(" → ");
}
