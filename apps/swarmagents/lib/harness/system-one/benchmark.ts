/**
 * Turns-per-task benchmark: replay a recorded agent trajectory through the
 * harness loop with and without System-1 and count the model turns spent.
 *
 * A trajectory is the sequence of model turns a run produced (assistant
 * text + tool calls with their results). The baseline ("pre-System-1
 * harness") runs every turn until the agent stops on its own. With System-1
 * the same loop asks the hooks after each turn and stops when afterTurn
 * returns a closing reply. Guardrail/patch verdicts are recorded too, so a
 * benchmark can show which tool calls System-1 would have escalated or
 * refused.
 *
 * Replay is deterministic and offline (the local scorer needs no model),
 * so the comparison is reproducible in CI.
 */

import type { TurnCall } from "./gates";
import type { BeforeToolVerdict, SystemOneHooks } from "./hooks";

export interface TrajectoryTurn {
  assistantText: string;
  calls: (TurnCall & { output?: string })[];
}

export interface Trajectory {
  name: string;
  prompt: string;
  turns: TrajectoryTurn[];
}

export interface ReplayResult {
  name: string;
  turns: number;
  stoppedEarly: boolean;
  closingReply?: string;
  verdicts: { turn: number; tool: string; verdict: BeforeToolVerdict }[];
  /** Output tokens saved by triage (Omnexx estimate). */
  triagedOutputs: number;
}

/** Replay without System-1: the agent runs every recorded turn. */
export function replayBaseline(t: Trajectory): ReplayResult {
  return { name: t.name, turns: t.turns.length, stoppedEarly: false, verdicts: [], triagedOutputs: 0 };
}

/** Replay through the System-1 hooks; stops at the first closing reply. */
export async function replayWithSystemOne(t: Trajectory, hooks: SystemOneHooks): Promise<ReplayResult> {
  await hooks.onPrompt(t.prompt);
  const verdicts: ReplayResult["verdicts"] = [];
  let triaged = 0;
  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i];
    for (const call of turn.calls) {
      verdicts.push({ turn: i + 1, tool: call.name, verdict: await hooks.beforeTool(call.name, call.input) });
      if (call.output !== undefined && (await hooks.afterTool(call.name, call.output)) !== call.output) triaged++;
    }
    const closing = await hooks.afterTurn(turn.calls, turn.assistantText, i + 1);
    if (closing !== undefined && i + 1 < t.turns.length) {
      return { name: t.name, turns: i + 1, stoppedEarly: true, closingReply: closing, verdicts, triagedOutputs: triaged };
    }
  }
  return { name: t.name, turns: t.turns.length, stoppedEarly: false, verdicts, triagedOutputs: triaged };
}
