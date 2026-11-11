export interface BreakerState {
  seenFailureKeys: Set<string>;
  axis: string;
  roundsWithoutImprovement: number;
  rung: number;
}

export type EscalationRung = 0 | 1 | 2 | 3 | 4;

export function createBreakerState(initialAxis = 'default'): BreakerState {
  return {
    seenFailureKeys: new Set(),
    axis: initialAxis,
    roundsWithoutImprovement: 0,
    rung: 0,
  };
}

/** B9: Axis Change — if a failure key repeats, force a pivot. */
export function b9AxisChange(state: BreakerState, failureKey: string): boolean {
  if (state.seenFailureKeys.has(failureKey)) {
    // pivot axis
    state.axis = `${state.axis}->pivot`;
    return true;
  }
  state.seenFailureKeys.add(failureKey);
  return false;
}

/** B10: Early Stopping — halt if 2 consecutive rounds yield zero improvement. */
export function b10EarlyStopping(state: BreakerState, improved: boolean): boolean {
  if (improved) {
    state.roundsWithoutImprovement = 0;
    return false;
  }
  state.roundsWithoutImprovement += 1;
  return state.roundsWithoutImprovement >= 2;
}

/** Literal Leak Detector — count verbatim literals/strings/mocked returns copied from issue/test. */
export function detectLiteralLeaks(patchDiff: string, sourceText: string): number {
  if (!patchDiff || !sourceText) return 0;
  // Extract candidate literals (quoted strings and numbers) from source text.
  const literals = new Set<string>();
  const re = /"([^"\n]{4,})"|'([^'\n]{4,})'|`([^`\n]{4,})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val) literals.add(val);
  }
  let leaks = 0;
  for (const lit of literals) {
    if (patchDiff.includes(lit)) leaks += 1;
  }
  return leaks;
}

/** 5-Rung Escalation Ladder: progressive model/temperature escalation (0..4). */
export function escalationRung(round: number): EscalationRung {
  const r = Math.max(0, Math.min(4, round));
  return r as EscalationRung;
}

export function advanceRung(state: BreakerState): EscalationRung {
  state.rung = Math.min(4, state.rung + 1);
  return state.rung as EscalationRung;
}
