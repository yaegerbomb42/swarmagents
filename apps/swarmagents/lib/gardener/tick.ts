import { loadStore } from "../board/store";
import { providerQuotaCooldowns, readConfiguredProviders } from "../providers/store";
import { getCodebaseHotspots, selectedCodebaseRepo } from "../codebase/store";
import type { CodebaseScanner } from "../codebase/types";
import type { VmManager } from "../vm/manager";
import { idealBoardTasks } from "./elo";
import { hasSurplusQuota } from "./quota";
import { proposalsFromAnalysis, proposalsFromBoard } from "./proposals";
import { readUserGardener, updateUserGardener } from "./store";
import type { BoardTaskInput, GardenerProposal, HotspotInput, QuotaProvider } from "./types";
import { inAutopilotWindow } from "./window";

export interface AutopilotTickInput {
  userId: string;
  now: number;
  enabled: boolean;
  idleMs: number;
  idleForMs: number;
  activeExec: boolean;
  providers: QuotaProvider[];
  workerElo: number;
  tasks: BoardTaskInput[];
  hotspotsByRepo: Record<string, HotspotInput[]>;
}

export interface AutopilotTickResult {
  ran: boolean;
  reason: string;
  added: number;
}

/** Pure decision: window + surplus quota, then queue proposals. Does not claim tasks or open PRs. */
export function decideAutopilotTick(
  input: AutopilotTickInput,
  existing: ReturnType<typeof readUserGardener>["proposals"],
): { result: AutopilotTickResult; proposals: typeof existing } {
  const window = inAutopilotWindow({
    enabled: input.enabled,
    idleMs: input.idleMs,
    idleForMs: input.idleForMs,
    activeExec: input.activeExec,
  });
  if (!window.ok) return { result: { ran: false, reason: window.reason, added: 0 }, proposals: [] };

  const quota = hasSurplusQuota(input.providers, input.now);
  if (!quota.ok) return { result: { ran: false, reason: quota.reason, added: 0 }, proposals: [] };

  const added: GardenerProposal[] = [];
  for (const [repoRoot, hotspots] of Object.entries(input.hotspotsByRepo)) {
    added.push(
      ...proposalsFromAnalysis({
        userId: input.userId,
        repoRoot,
        hotspots,
        now: input.now,
        existing: [...existing, ...added],
      }),
    );
  }
  const matched = idealBoardTasks(input.tasks, input.workerElo);
  added.push(
    ...proposalsFromBoard({
      userId: input.userId,
      tasks: matched,
      now: input.now,
      existing: [...existing, ...added],
    }),
  );
  return {
    result: { ran: true, reason: quota.reason, added: added.length },
    proposals: added,
  };
}

function providersFor(userId: string, now: number): QuotaProvider[] {
  const cooldowns = providerQuotaCooldowns(userId);
  return readConfiguredProviders(userId).map((provider) => ({
    id: provider.id,
    isFree: provider.isFree,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    dailyBudgetUsd: provider.dailyBudgetUsd,
    quotaExhaustedUntil: cooldowns[provider.id],
    spentTodayUsd: undefined,
  })).map((provider) => {
    if (provider.quotaExhaustedUntil && provider.quotaExhaustedUntil <= now) {
      return { ...provider, quotaExhaustedUntil: undefined };
    }
    return provider;
  });
}

function openTasks(): BoardTaskInput[] {
  try {
    return loadStore().tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      minElo: task.minElo,
    }));
  } catch {
    return [];
  }
}

/**
 * Live tick for one user. Scanner is optional: without one, only pinned
 * paths that already have hotspot snapshots in the caller's map are skipped
 * and the board is still polled. Pass hotspots via the pure function in tests.
 */
export async function runAutopilotTick(
  userId: string,
  vm: Pick<VmManager, "idle" | "idleForMs" | "hasActiveExec">,
  scanner?: CodebaseScanner,
  now = Date.now(),
): Promise<AutopilotTickResult> {
  const state = readUserGardener(userId);
  const hotspotsByRepo: Record<string, HotspotInput[]> = {};
  if (scanner && state.enabled) {
    const roots = new Set(state.pinned.map((p) => p.repoRoot));
    const selected = await selectedCodebaseRepo(userId, scanner);
    if (selected) roots.add(selected);
    for (const repoRoot of roots) {
      try {
        const spots = await getCodebaseHotspots(userId, scanner, repoRoot, 12);
        hotspotsByRepo[repoRoot] = spots.map((spot) => ({
          path: spot.path,
          heat: spot.heat,
          coveragePct: spot.coveragePct,
        }));
      } catch (err) {
        console.error(`[gardener] analysis failed for ${repoRoot}:`, err);
      }
    }
  }
  const decision = decideAutopilotTick(
    {
      userId,
      now,
      enabled: state.enabled,
      idleMs: vm.idle.idleMs,
      idleForMs: vm.idleForMs(userId, now),
      activeExec: vm.hasActiveExec(userId),
      providers: providersFor(userId, now),
      workerElo: state.workerElo,
      tasks: openTasks(),
      hotspotsByRepo,
    },
    state.proposals,
  );
  if (decision.proposals.length > 0) {
    updateUserGardener(userId, (next) => {
      next.proposals.push(...decision.proposals);
    });
  }
  return decision.result;
}

export async function runAutopilotForUsers(
  userIds: string[],
  vm: Pick<VmManager, "idle" | "idleForMs" | "hasActiveExec">,
): Promise<void> {
  for (const userId of userIds) {
    try {
      await runAutopilotTick(userId, vm);
    } catch (err) {
      console.error(`[gardener] tick failed for ${userId}:`, err);
    }
  }
}
