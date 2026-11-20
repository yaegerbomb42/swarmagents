/**
 * Persistent Arena Leaderboard, Battle Recorder & Adaptive Matchmaker.
 *
 * Bridges the pure Elo math (`./elo`), race/hedge telemetry (`./race`), and
 * verification-gated battle runner (`./runner`) into the Swarm Board's live
 * rating table:
 *
 * - Ratings are tracked per `provider/model` key and persisted via
 *   `atomicWriteFile` with a pre-rename JSON/schema validation hook.
 * - Every recorded battle publishes an `arena.battle.recorded` event onto
 *   `telemetryBus` so the UI updates live.
 * - Mutual verification failures (`!winner.passed && !loser.passed`) are
 *   scored as draws so unverified outputs never inflate a model's Elo.
 * - `selectArenaMatchup` pairs contenders using Elo proximity, an
 *   under-sampled calibration bonus, and a recency cooldown.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "../atomic-write";
import { telemetryBus, type TelemetryBus } from "../telemetry/bus";
import { ELO_DEFAULT_RATING, ELO_STARTING_K, expectedScore, updateElo } from "./elo";
import { formatHedgeLine } from "./race";
import {
  runArenaBattle,
  type ArenaBattleOptions,
  type ArenaBattleResult,
  type ArenaOutcome,
} from "./runner";

export const ARENA_LEADERBOARD_SCHEMA = "swarm-arena-leaderboard";
export const ARENA_LEADERBOARD_VERSION = 1;
export const DEFAULT_MAX_HISTORY = 200;
export const ARENA_TELEMETRY_CHANNEL = "arena";

export interface ArenaPlayerStats {
  /** Canonical player key, e.g. `anthropic/claude-sonnet-4-5`. */
  player: string;
  provider: string;
  model?: string;
  rating: number;
  peakRating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  /** Positive for consecutive wins, negative for consecutive losses, 0 after draw. */
  streak: number;
  /** Exponential moving average of total latency (ms). */
  avgLatencyMs: number;
  /** Exponential moving average of verification score (0..100). */
  avgScore: number;
  totalCostUsd: number;
  /** Battles won where a hedged fallback fired. */
  hedgeWins: number;
  lastPlayedAt: number;
}

export interface ArenaMatchRecord {
  id: string;
  recordedAt: number;
  promptTag?: string;
  outcome: "win" | "draw";
  winner: string;
  loser: string;
  winnerRatingBefore: number;
  winnerRatingAfter: number;
  loserRatingBefore: number;
  loserRatingAfter: number;
  /** Net rating points transferred from loser to winner (can be negative on an upset draw). */
  delta: number;
  winnerScore: number;
  loserScore: number;
  winnerLatencyMs: number;
  loserLatencyMs: number;
  hedgeFired: boolean;
  raceSummary: string;
}

export interface ArenaLeaderboardSnapshot {
  schema: typeof ARENA_LEADERBOARD_SCHEMA;
  version: typeof ARENA_LEADERBOARD_VERSION;
  updatedAt: number;
  players: Record<string, ArenaPlayerStats>;
  history: ArenaMatchRecord[];
}

export interface RecordBattleOptions {
  /** Optional tag grouping battles by task family (e.g. "bugfix", "ui"). */
  promptTag?: string;
  /** Override K-factor instead of using the dynamic provisional/veteran scale. */
  k?: number;
  /** Treat a battle where both contenders failed verification as a draw. Default true. */
  drawOnMutualFailure?: boolean;
  now?: number;
}

export interface MatchupOptions {
  /** Number of recent matches checked when penalizing repeat pairings. Default 5. */
  recentWindow?: number;
}

let leaderboardPathOverride: string | undefined;

/** Redirect the default leaderboard file (used in tests; pass undefined to reset). */
export function configureArenaLeaderboardPath(filePath: string | undefined): void {
  leaderboardPathOverride = filePath;
}

export function getArenaLeaderboardFile(): string {
  if (leaderboardPathOverride !== undefined) return leaderboardPathOverride;
  const home = process.env.SWARM_HOME?.trim();
  if (home) return path.join(home, "arena-leaderboard.json");
  return path.join(process.cwd(), ".swarm-arena", "arena-leaderboard.json");
}

/** Canonical player identifier from provider and optional model name. */
export function playerKey(provider: string, model?: string): string {
  const cleanProvider = provider.trim();
  const cleanModel = model?.trim();
  if (!cleanModel) return cleanProvider;
  if (cleanModel.startsWith(`${cleanProvider}/`)) return cleanModel;
  return `${cleanProvider}/${cleanModel}`;
}

/**
 * Volatility schedule: provisional players (<10 matches) converge faster (K=40),
 * standard players use ELO_STARTING_K (32), and established top-tier models
 * (>=1600 rating with >=20 matches) stabilize (K=20).
 */
export function dynamicKFactor(stats?: Pick<ArenaPlayerStats, "matches" | "rating">): number {
  if (!stats || stats.matches < 10) return 40;
  if (stats.matches >= 20 && stats.rating >= 1600) return 20;
  return ELO_STARTING_K;
}

function emptyPlayer(provider: string, model: string | undefined, now: number): ArenaPlayerStats {
  return {
    player: playerKey(provider, model),
    provider: provider.trim(),
    ...(model?.trim() ? { model: model.trim() } : {}),
    rating: ELO_DEFAULT_RATING,
    peakRating: ELO_DEFAULT_RATING,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
    avgLatencyMs: 0,
    avgScore: 0,
    totalCostUsd: 0,
    hedgeWins: 0,
    lastPlayedAt: now,
  };
}

function updateEma(previous: number, sample: number, matches: number, decimals = 0): number {
  const next = matches === 0 ? sample : previous * 0.7 + sample * 0.3;
  if (decimals <= 0) return Math.round(next);
  const factor = 10 ** decimals;
  return Math.round(next * factor) / factor;
}

function applyOutcomeStats(
  base: ArenaPlayerStats,
  outcome: ArenaOutcome,
  newRating: number,
  result: "win" | "loss" | "draw",
  hedgeWon: boolean,
  now: number,
): ArenaPlayerStats {
  const nextStreak =
    result === "draw"
      ? 0
      : result === "win"
        ? base.streak > 0
          ? base.streak + 1
          : 1
        : base.streak < 0
          ? base.streak - 1
          : -1;

  return {
    ...base,
    rating: newRating,
    peakRating: Math.max(base.peakRating, newRating),
    matches: base.matches + 1,
    wins: base.wins + (result === "win" ? 1 : 0),
    losses: base.losses + (result === "loss" ? 1 : 0),
    draws: base.draws + (result === "draw" ? 1 : 0),
    streak: nextStreak,
    avgLatencyMs: updateEma(base.avgLatencyMs, outcome.latencyMs, base.matches, 0),
    avgScore: updateEma(base.avgScore, outcome.score, base.matches, 2),
    totalCostUsd: Math.round((base.totalCostUsd + (outcome.costUsd ?? 0)) * 1_000_000) / 1_000_000,
    hedgeWins: base.hedgeWins + (hedgeWon ? 1 : 0),
    lastPlayedAt: now,
  };
}

/** Sort leaderboard entries by Elo descending, then win rate, then lower latency. */
export function rankLeaderboard(players: Iterable<ArenaPlayerStats>): ArenaPlayerStats[] {
  return [...players].sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    const rateA = a.matches > 0 ? a.wins / a.matches : 0;
    const rateB = b.matches > 0 ? b.wins / b.matches : 0;
    if (rateB !== rateA) return rateB - rateA;
    if (a.avgLatencyMs !== b.avgLatencyMs) return a.avgLatencyMs - b.avgLatencyMs;
    return a.player.localeCompare(b.player);
  });
}

/**
 * Adaptive matchmaker: selects the most informative pair of contenders from
 * `contenders` by combining:
 * 1. Rating proximity (competitive matches yield stronger signal),
 * 2. Under-sampled exploration bonus (newly added models get calibrated fast),
 * 3. Recency decay (avoids re-running the exact same pair back-to-back).
 */
export function selectArenaMatchup<T extends { provider: string; model?: string }>(
  contenders: readonly T[],
  players: Readonly<Record<string, ArenaPlayerStats>>,
  recentHistory: readonly ArenaMatchRecord[] = [],
  options: MatchupOptions = {},
): [T, T] | null {
  const unique: T[] = [];
  const seenKeys = new Set<string>();
  for (const c of contenders) {
    const key = playerKey(c.provider, c.model);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(c);
  }
  if (unique.length < 2) return null;

  const recentWindow = Math.max(0, options.recentWindow ?? 5);
  const recent = recentHistory.slice(0, recentWindow);

  let bestPair: [T, T] = [unique[0], unique[1]];
  let bestScore = -Infinity;

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];
      const keyA = playerKey(a.provider, a.model);
      const keyB = playerKey(b.provider, b.model);
      const statsA = players[keyA];
      const statsB = players[keyB];

      const ratingA = statsA?.rating ?? ELO_DEFAULT_RATING;
      const ratingB = statsB?.rating ?? ELO_DEFAULT_RATING;
      const matchesA = statsA?.matches ?? 0;
      const matchesB = statsB?.matches ?? 0;

      // 1. Gaussian closeness in Elo (width 250 pts).
      const diff = (ratingA - ratingB) / 250;
      const closeness = Math.exp(-(diff * diff));

      // 2. Exploration bonus for contenders with few recorded matches.
      const exploration = 1 / Math.sqrt(1 + Math.min(matchesA, matchesB));

      // 3. Cooldown penalty for pairs that faced each other recently.
      let repeats = 0;
      for (const match of recent) {
        if (
          (match.winner === keyA && match.loser === keyB) ||
          (match.winner === keyB && match.loser === keyA)
        ) {
          repeats += 1;
        }
      }
      const novelty = Math.pow(0.35, repeats);

      const score = (0.55 * closeness + 0.45 * exploration) * novelty;
      if (score > bestScore) {
        bestScore = score;
        bestPair = [a, b];
      }
    }
  }

  return bestPair;
}

function emptySnapshot(now = Date.now()): ArenaLeaderboardSnapshot {
  return {
    schema: ARENA_LEADERBOARD_SCHEMA,
    version: ARENA_LEADERBOARD_VERSION,
    updatedAt: now,
    players: {},
    history: [],
  };
}

function validateSnapshotBytes(tmpPath: string): void {
  const parsed = JSON.parse(fs.readFileSync(tmpPath, "utf8")) as Partial<ArenaLeaderboardSnapshot>;
  if (
    !parsed ||
    parsed.schema !== ARENA_LEADERBOARD_SCHEMA ||
    parsed.version !== ARENA_LEADERBOARD_VERSION ||
    typeof parsed.players !== "object" ||
    parsed.players === null ||
    !Array.isArray(parsed.history)
  ) {
    throw new Error("Invalid arena leaderboard snapshot schema");
  }
}

export interface ArenaLeaderboardStoreOptions {
  filePath?: string;
  bus?: TelemetryBus;
  maxHistory?: number;
  channel?: string;
}

export class ArenaLeaderboardStore {
  private readonly explicitPath?: string;
  private readonly bus: TelemetryBus;
  private readonly maxHistory: number;
  private readonly channel: string;

  constructor(options: ArenaLeaderboardStoreOptions = {}) {
    this.explicitPath = options.filePath;
    this.bus = options.bus ?? telemetryBus;
    this.maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
    this.channel = options.channel ?? ARENA_TELEMETRY_CHANNEL;
  }

  get filePath(): string {
    return this.explicitPath ?? getArenaLeaderboardFile();
  }

  load(): ArenaLeaderboardSnapshot {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ArenaLeaderboardSnapshot>;
      if (
        !parsed ||
        parsed.schema !== ARENA_LEADERBOARD_SCHEMA ||
        parsed.version !== ARENA_LEADERBOARD_VERSION ||
        typeof parsed.players !== "object" ||
        parsed.players === null ||
        !Array.isArray(parsed.history)
      ) {
        return emptySnapshot();
      }
      return {
        schema: ARENA_LEADERBOARD_SCHEMA,
        version: ARENA_LEADERBOARD_VERSION,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
        players: parsed.players,
        history: parsed.history.slice(0, this.maxHistory),
      };
    } catch {
      return emptySnapshot();
    }
  }

  private save(snapshot: ArenaLeaderboardSnapshot): void {
    const file = this.filePath;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
      validate: validateSnapshotBytes,
    });
  }

  /** Ranked player standings, highest Elo first. */
  standings(): ArenaPlayerStats[] {
    return rankLeaderboard(Object.values(this.load().players));
  }

  /** Single player's stats, or null if they have not competed yet. */
  player(provider: string, model?: string): ArenaPlayerStats | null {
    return this.load().players[playerKey(provider, model)] ?? null;
  }

  /** Recent recorded battles, newest first. */
  recentMatches(limit = 20): ArenaMatchRecord[] {
    return this.load().history.slice(0, Math.max(0, limit));
  }

  /** Pick the best next pairing from a pool of contenders. */
  pickMatchup<T extends { provider: string; model?: string }>(
    contenders: readonly T[],
    options?: MatchupOptions,
  ): [T, T] | null {
    const snap = this.load();
    return selectArenaMatchup(contenders, snap.players, snap.history, options);
  }

  /**
   * Record a completed `ArenaBattleResult`, update both contenders' Elo and
   * performance metrics atomically, and publish `arena.battle.recorded`.
   */
  recordBattle(battle: ArenaBattleResult, options: RecordBattleOptions = {}): ArenaMatchRecord {
    if (battle.outcomes.length < 2) {
      throw new Error("Arena battle must contain at least two outcomes");
    }
    if (!battle.winner) {
      // No contender produced a viable outcome (e.g. every contender failed);
      // there is no Elo update to record.
      throw new Error("Arena battle has no winner to record");
    }
    const now = options.now ?? Date.now();
    const snap = this.load();

    const winnerOutcome = battle.winner;
    const loserOutcome =
      battle.outcomes.find((o) => o !== winnerOutcome) ??
      battle.outcomes.find((o) => playerKey(o.provider, o.model) !== playerKey(winnerOutcome.provider, winnerOutcome.model)) ??
      battle.outcomes[1];

    const winnerId = playerKey(winnerOutcome.provider, winnerOutcome.model);
    const loserId = playerKey(loserOutcome.provider, loserOutcome.model);

    const prevWinner = snap.players[winnerId] ?? emptyPlayer(winnerOutcome.provider, winnerOutcome.model, now);
    const prevLoser = snap.players[loserId] ?? emptyPlayer(loserOutcome.provider, loserOutcome.model, now);

    const mutualFailure = !winnerOutcome.passed && !loserOutcome.passed;
    const isDraw = (options.drawOnMutualFailure ?? true) && mutualFailure;

    const effectiveK =
      options.k ?? Math.round((dynamicKFactor(prevWinner) + dynamicKFactor(prevLoser)) / 2);

    let nextWinnerRating: number;
    let nextLoserRating: number;
    let delta: number;

    if (isDraw) {
      const expWinner = expectedScore(prevWinner.rating, prevLoser.rating);
      delta = Math.round(effectiveK * (0.5 - expWinner));
      nextWinnerRating = prevWinner.rating + delta;
      nextLoserRating = prevLoser.rating - delta;
    } else {
      const updated = updateElo(prevWinner.rating, prevLoser.rating, { k: effectiveK });
      nextWinnerRating = updated.winner;
      nextLoserRating = updated.loser;
      delta = updated.delta;
    }

    const hedgeWon = !isDraw && battle.race.hedgeFired;
    snap.players[winnerId] = applyOutcomeStats(
      prevWinner,
      winnerOutcome,
      nextWinnerRating,
      isDraw ? "draw" : "win",
      hedgeWon,
      now,
    );
    snap.players[loserId] = applyOutcomeStats(
      prevLoser,
      loserOutcome,
      nextLoserRating,
      isDraw ? "draw" : "loss",
      false,
      now,
    );

    const record: ArenaMatchRecord = {
      id: `match_${randomUUID()}`,
      recordedAt: now,
      ...(options.promptTag?.trim() ? { promptTag: options.promptTag.trim() } : {}),
      outcome: isDraw ? "draw" : "win",
      winner: winnerId,
      loser: loserId,
      winnerRatingBefore: prevWinner.rating,
      winnerRatingAfter: nextWinnerRating,
      loserRatingBefore: prevLoser.rating,
      loserRatingAfter: nextLoserRating,
      delta,
      winnerScore: winnerOutcome.score,
      loserScore: loserOutcome.score,
      winnerLatencyMs: winnerOutcome.latencyMs,
      loserLatencyMs: loserOutcome.latencyMs,
      hedgeFired: battle.race.hedgeFired,
      raceSummary: formatHedgeLine(battle.race),
    };

    snap.history = [record, ...snap.history].slice(0, this.maxHistory);
    snap.updatedAt = now;
    this.save(snap);

    try {
      this.bus.publish(this.channel, {
        type: "arena.battle.recorded",
        data: {
          match: record,
          standings: rankLeaderboard(Object.values(snap.players)).slice(0, 10),
        },
      });
    } catch {
      // Telemetry must never fail a recorded match.
    }

    return record;
  }

  /** Convenience helper: execute `runArenaBattle` and persist its outcome in one step. */
  async runAndRecordBattle(
    battleOptions: ArenaBattleOptions,
    recordOptions: RecordBattleOptions = {},
  ): Promise<{ battle: ArenaBattleResult; match: ArenaMatchRecord }> {
    const battle = await runArenaBattle(battleOptions);
    const match = this.recordBattle(battle, recordOptions);
    return { battle, match };
  }
}

const g = globalThis as typeof globalThis & { __swarmArenaLeaderboard?: ArenaLeaderboardStore };

export function getArenaLeaderboard(): ArenaLeaderboardStore {
  if (!g.__swarmArenaLeaderboard) {
    g.__swarmArenaLeaderboard = new ArenaLeaderboardStore();
  }
  return g.__swarmArenaLeaderboard;
}

export function setArenaLeaderboardForTesting(store: ArenaLeaderboardStore | null): void {
  g.__swarmArenaLeaderboard = store ?? undefined;
}
