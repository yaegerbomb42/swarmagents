import { buildRaceReport, type RaceMode, type RaceParticipant, type RaceReport } from "./race";
import type { VerificationResult } from "../verification";

export interface ContenderRunContext {
  signal: AbortSignal;
  /** Call as soon as the first output token/chunk arrives to record true TTFT. */
  onFirstToken: () => void;
}

export interface ArenaContender {
  provider: string;
  model?: string;
  run: (ctx: ContenderRunContext) => Promise<{ text: string; latencyMs?: number; costUsd?: number }>;
}

export interface ArenaOutcome {
  provider: string;
  model?: string;
  text: string;
  firstTokenMs?: number;
  latencyMs: number;
  costUsd?: number;
  verification: VerificationResult;
  score: number;
  passed: boolean;
  status: "winner" | "aborted" | "failed";
}

export interface ArenaBattleOptions {
  /** Two or more contenders; index 0 is the primary in hedged mode. */
  contenders: readonly ArenaContender[];
  mode?: RaceMode;
  hedgeDelayMs?: number;
  /** Minimum verification score that allows early-cancelling slower contenders. */
  earlyWinMinScore?: number;
  verify: (ctx: { provider: string; model?: string; text: string }) => Promise<VerificationResult>;
}

export interface ArenaBattleResult {
  outcomes: ArenaOutcome[];
  /** Null when every contender failed to execute. */
  winner: ArenaOutcome | null;
  isDraw: boolean;
  race: RaceReport;
}

function failedOutcome(contender: ArenaContender, reason: string, latencyMs = 0): ArenaOutcome {
  return {
    provider: contender.provider,
    model: contender.model,
    text: "",
    latencyMs,
    verification: { status: "failed", passed: false, score: 0, violations: [reason] },
    score: 0,
    passed: false,
    status: "failed",
  };
}

export async function runArenaBattle(options: ArenaBattleOptions): Promise<ArenaBattleResult> {
  if (options.contenders.length < 2) {
    throw new Error("Arena battle requires at least two contenders");
  }
  const mode: RaceMode = options.mode ?? "hedged";
  const hedgeDelayMs = Math.max(0, options.hedgeDelayMs ?? 1500);
  const earlyWinMinScore = options.earlyWinMinScore ?? 90;

  const outcomes: Array<ArenaOutcome | undefined> = new Array(options.contenders.length);
  const controllers = options.contenders.map(() => new AbortController());
  let primarySettledEarly = false;
  let notifyPrimaryDone: (() => void) | null = null;

  const runOne = async (index: number): Promise<void> => {
    const contender = options.contenders[index];
    if (mode === "hedged" && index > 0 && hedgeDelayMs > 0 && !primarySettledEarly) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, hedgeDelayMs * index);
        timer.unref?.();
        const prev = notifyPrimaryDone;
        notifyPrimaryDone = () => {
          prev?.();
          clearTimeout(timer);
          resolve();
        };
        controllers[index].signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    if (controllers[index].signal.aborted) {
      outcomes[index] = failedOutcome(contender, "Aborted before start");
      return;
    }

    const startedAt = performance.now();
    let firstTokenMs: number | undefined;
    try {
      const res = await contender.run({
        signal: controllers[index].signal,
        onFirstToken: () => {
          if (firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - startedAt);
        },
      });
      const latencyMs = res.latencyMs ?? Math.round(performance.now() - startedAt);
      const verification = await options.verify({
        provider: contender.provider,
        model: contender.model,
        text: res.text,
      });
      const outcome: ArenaOutcome = {
        provider: contender.provider,
        model: contender.model,
        text: res.text,
        firstTokenMs: firstTokenMs ?? latencyMs,
        latencyMs,
        costUsd: res.costUsd,
        verification,
        score: verification.score,
        passed: verification.passed,
        status: "aborted",
      };
      outcomes[index] = outcome;

      if (index === 0) {
        primarySettledEarly = true;
        notifyPrimaryDone?.();
      }

      if (outcome.passed && outcome.score >= earlyWinMinScore) {
        for (let i = 0; i < controllers.length; i++) {
          if (i !== index && !outcomes[i]) controllers[i].abort();
        }
      }
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      if (index === 0) {
        primarySettledEarly = true;
        notifyPrimaryDone?.();
      }
      const message = controllers[index].signal.aborted
        ? "Contender aborted after peer won"
        : `Contender failed to run: ${error instanceof Error ? error.message : String(error)}`;
      outcomes[index] = failedOutcome(contender, message, latencyMs);
    }
  };

  await Promise.all(options.contenders.map((_, idx) => runOne(idx)));

  const finalized = outcomes.map((o, i) => o ?? failedOutcome(options.contenders[i], "No outcome recorded"));
  const viable = finalized
    .filter((o) => o.status !== "failed")
    .sort((x, y) => y.score - x.score || x.latencyMs - y.latencyMs || (x.costUsd ?? 0) - (y.costUsd ?? 0));

  const winner = viable[0] ?? null;
  if (winner) {
    winner.status = "winner";
    for (const o of finalized) {
      if (o !== winner && o.status !== "failed") o.status = "aborted";
    }
  }

  const isDraw =
    viable.length >= 2 &&
    viable[0].score === viable[1].score &&
    viable[0].passed === viable[1].passed;

  const participants: RaceParticipant[] = finalized.map((o) => ({
    provider: o.provider,
    model: o.model,
    firstTokenMs: o.firstTokenMs,
    latencyMs: o.latencyMs,
    costUsd: o.costUsd,
    status: o.status,
  }));

  const race = buildRaceReport(mode, participants, hedgeDelayMs);
  return { outcomes: finalized, winner, isDraw, race };
}
