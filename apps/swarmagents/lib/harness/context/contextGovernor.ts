/**
 * L1 context packer: rebuild each turn's prompt from a fixed 8,192-token
 * budget instead of appending history without limit.
 *
 * Ported from the Claude Code mini's ContextGovernor
 * (vendor/claude-code-mini/src/contextGovernor.ts: MAX_TOTAL_TOKENS=8192,
 * MAX_INPUT_TOKENS=7200, OUTPUT_BUFFER_TOKENS=992, fitWithinBudget). The
 * mini packed one payload; the harness needs a multi-file turn, so the
 * budget is split into four named sections:
 *
 *   state ledger   ~600   goal, constraints, last error, recent steps
 *   AST skeleton  ~1,500  symbol outlines of the files in scope
 *   working set   ~3,500  numbered line windows of the files being edited
 *   reserve       ~2,400  system header (≤1,408) + output buffer (992)
 *
 * 600 + 1,500 + 3,500 + 2,400 = 8,000, leaving 192 tokens of headroom for
 * estimate error. Input never exceeds 7,200 (the mini's MAX_INPUT_TOKENS).
 * Unused ledger/skeleton budget rolls into the working set; nothing ever
 * rolls into (or out of) the output buffer.
 *
 * State is externalized: the ledger is the only memory between turns, so
 * each turn is packed fresh and the runner must NOT --resume the CLI
 * session when this packer is active (see toPackedRunRequest).
 *
 * Selection: the packer is an OPTION. resolveContextPacker defaults to
 * "claude-code" (the existing ClaudeCodeRunner behaviour, untouched);
 * "l1" is opt-in per run or per role.
 *
 * Keys: this module never reads env, files or provider config.
 */

import { estimateTokens } from "../../codebase/tokens";
import type { RunRequest } from "../types";
import { buildSkeleton, buildWorkingSet, type SourceFile, type WorkingSetItem } from "./astSlicer";

export { estimateTokens };

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface L1Budget {
  /** Hard ceiling for one turn: input + output buffer. */
  total: number;
  ledger: number;
  skeleton: number;
  workingSet: number;
  /** System header + output buffer. */
  reserve: number;
  /** Part of `reserve` kept free for the model's reply. */
  outputBuffer: number;
}

export const MAX_TOTAL_TOKENS = 8192;
export const MAX_INPUT_TOKENS = 7200;
export const OUTPUT_BUFFER_TOKENS = 992;

export const DEFAULT_L1_BUDGET: Readonly<L1Budget> = Object.freeze({
  total: MAX_TOTAL_TOKENS,
  ledger: 600,
  skeleton: 1500,
  workingSet: 3500,
  reserve: 2400,
  outputBuffer: OUTPUT_BUFFER_TOKENS,
});

/** Merge overrides and reject budgets whose sections overflow the total. */
export function resolveBudget(overrides: Partial<L1Budget> = {}): L1Budget {
  const budget: L1Budget = { ...DEFAULT_L1_BUDGET, ...overrides };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`L1 budget ${key} must be a non-negative number`);
  }
  const sections = budget.ledger + budget.skeleton + budget.workingSet + budget.reserve;
  if (sections > budget.total) {
    throw new RangeError(`L1 budget sections (${sections}) exceed the turn total (${budget.total})`);
  }
  if (budget.outputBuffer > budget.reserve) {
    throw new RangeError("L1 budget outputBuffer must fit inside reserve");
  }
  return budget;
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

/** Tokens set aside (inside the working set) for the "not shown" note. */
const OMITTED_NOTE_TOKENS = 80;

const SNIP = "\n[…snipped for L1 budget…]\n";

/**
 * Cut `text` to at most `cap` estimated tokens.
 *  - "head": keep the start (goals, instructions).
 *  - "tail": keep the end (stack traces: the cause is at the bottom).
 *  - "middle": keep the first fifth and the last four fifths, like the mini.
 */
export function fitText(text: string, cap: number, keep: "head" | "tail" | "middle" = "head"): string {
  if (cap <= 0 || !text) return "";
  if (estimateTokens(text) <= cap) return text;

  const build = (n: number): string => {
    if (keep === "head") return text.slice(0, n) + SNIP.trimEnd();
    if (keep === "tail") return SNIP.trimStart() + text.slice(text.length - n);
    const front = Math.floor(n / 5);
    return text.slice(0, front) + SNIP + text.slice(text.length - (n - front));
  };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(build(mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return estimateTokens(SNIP.trim()) <= cap ? SNIP.trim() : "";
  return build(lo);
}

// ---------------------------------------------------------------------------
// State ledger
// ---------------------------------------------------------------------------

export interface LedgerStep {
  turn: number;
  summary: string;
}

export interface StateLedgerSnapshot {
  goal: string;
  constraints: string[];
  steps: LedgerStep[];
  lastError?: string;
  notes: string[];
}

/**
 * The externalized state carried between turns. Serializable (toJSON /
 * fromJSON) so the runtime can persist it next to the run.
 */
export class StateLedger {
  private snapshot: StateLedgerSnapshot;

  constructor(goal: string, init: Partial<Omit<StateLedgerSnapshot, "goal">> = {}) {
    this.snapshot = {
      goal,
      constraints: [...(init.constraints ?? [])],
      steps: [...(init.steps ?? [])],
      lastError: init.lastError,
      notes: [...(init.notes ?? [])],
    };
  }

  static fromJSON(value: StateLedgerSnapshot): StateLedger {
    return new StateLedger(value.goal, value);
  }

  toJSON(): StateLedgerSnapshot {
    return structuredClone(this.snapshot);
  }

  get goal(): string {
    return this.snapshot.goal;
  }

  recordStep(turn: number, summary: string): void {
    this.snapshot.steps.push({ turn, summary: summary.trim() });
  }

  setError(error: string | undefined): void {
    this.snapshot.lastError = error?.trim() || undefined;
  }

  addNote(note: string): void {
    this.snapshot.notes.push(note.trim());
  }

  /**
   * Render within `cap` tokens. Priority: goal (≤40% of cap), last error
   * (≤35%, tail kept), constraints, notes, then the most recent steps that
   * still fit, with a count of the elided older ones.
   */
  render(turn: number, cap: number): string {
    if (cap <= 0) return "";
    const s = this.snapshot;
    const lines: string[] = [`## State ledger (turn ${turn})`, `Goal: ${fitText(s.goal, Math.floor(cap * 0.4))}`];
    if (s.lastError) lines.push(`Last error:\n${fitText(s.lastError, Math.floor(cap * 0.35), "tail")}`);
    const fixed = (extra: string[]) => [...lines, ...extra].join("\n");

    const extras: string[] = [];
    for (const c of s.constraints) {
      const candidate = `- constraint: ${c}`;
      if (estimateTokens(fixed([...extras, candidate])) <= cap) extras.push(candidate);
    }
    for (const n of s.notes) {
      const candidate = `- note: ${n}`;
      if (estimateTokens(fixed([...extras, candidate])) <= cap) extras.push(candidate);
    }

    const recent: string[] = [];
    let elided = 0;
    for (let i = s.steps.length - 1; i >= 0; i--) {
      const candidate = `- t${s.steps[i].turn}: ${s.steps[i].summary}`;
      // Leave room for the "N earlier steps elided" line.
      const marker = i > 0 ? [`(${i} earlier steps elided)`] : [];
      if (estimateTokens(fixed([...extras, "Steps so far:", ...marker, candidate, ...recent])) <= cap) {
        recent.unshift(candidate);
      } else {
        elided = i + 1;
        break;
      }
    }
    if (recent.length || elided) {
      extras.push("Steps so far:");
      if (elided) extras.push(`(${elided} earlier steps elided)`);
      extras.push(...recent);
    }

    const text = fixed(extras);
    // The goal/error caps already bound the text; this is a last guard.
    return estimateTokens(text) <= cap ? text : fitText(text, cap);
  }
}

// ---------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------

export interface PackTurnInput {
  turn: number;
  ledger: StateLedger;
  /** Files in scope: outlined into the AST skeleton. */
  skeletonFiles: SourceFile[];
  /** Files being edited: shown as numbered line windows. */
  workingSet: WorkingSetItem[];
  /**
   * Caller instructions folded into the system header (agent card, role
   * prompt, memory). Cut to fit what is left of the reserve after the
   * output buffer.
   */
  systemExtras?: string[];
}

export interface SectionUsage {
  used: number;
  cap: number;
}

export interface PackedTurn {
  /** System prompt for the turn (micro-rules + systemExtras). */
  systemPrompt: string;
  /** User prompt: ledger + skeleton + working set. */
  prompt: string;
  usage: {
    ledger: SectionUsage;
    skeleton: SectionUsage;
    /** cap includes rollover from ledger/skeleton. */
    workingSet: SectionUsage & { rollover: number };
    reserve: { used: number; cap: number; system: number; output: number };
    /** Input tokens (system + prompt). */
    input: number;
    /** input + output buffer: what the turn can cost at most. */
    total: number;
    budget: number;
  };
  /** Files that did not fit anywhere this turn. */
  omitted: string[];
  /** One-line budget summary, also passed to the `log` callback. */
  logLine: string;
}

export const L1_SYSTEM_RULES = [
  "L1 context mode: this turn was packed fresh from a fixed 8,192-token budget.",
  "You have no conversation memory. Rely only on the state ledger, the code skeleton and the working set below.",
  "Make deterministic edits: unified diffs or exact block replacements. No pleasantries.",
  "If you need a file or lines not shown, say which (path and line range) instead of guessing.",
].join("\n");

export interface ContextGovernorOptions {
  budget?: Partial<L1Budget>;
  /** Receives the budget ledger line for each packed turn. */
  log?: (line: string) => void;
}

export function formatBudgetLine(turn: number, usage: PackedTurn["usage"], omitted: number): string {
  const ws = usage.workingSet;
  const r = usage.reserve;
  return (
    `context-packer[l1] turn=${turn} budget=${usage.budget}` +
    ` ledger=${usage.ledger.used}/${usage.ledger.cap}` +
    ` skeleton=${usage.skeleton.used}/${usage.skeleton.cap}` +
    ` working=${ws.used}/${ws.cap}${ws.rollover ? ` (+${ws.rollover} rollover)` : ""}` +
    ` reserve=${r.used}/${r.cap} (system ${r.system}, output ${r.output})` +
    ` total=${usage.total}/${usage.budget}` +
    (omitted ? ` omitted=${omitted}` : "")
  );
}

export class ContextGovernor {
  readonly budget: L1Budget;
  private readonly log?: (line: string) => void;

  constructor(options: ContextGovernorOptions = {}) {
    this.budget = resolveBudget(options.budget);
    this.log = options.log;
  }

  pack(input: PackTurnInput): PackedTurn {
    const b = this.budget;
    const systemCap = b.reserve - b.outputBuffer;

    // System header: rules first (never cut unless the cap is tiny), then extras.
    const extras = (input.systemExtras ?? []).map((x) => x.trim()).filter(Boolean).join("\n\n");
    const rulesCost = estimateTokens(L1_SYSTEM_RULES);
    const systemPrompt =
      rulesCost >= systemCap
        ? fitText(L1_SYSTEM_RULES, systemCap)
        : extras
          ? `${L1_SYSTEM_RULES}\n\n${fitText(extras, systemCap - rulesCost - 2)}`
          : L1_SYSTEM_RULES;

    const ledgerText = input.ledger.render(input.turn, b.ledger);
    const ledgerUsed = estimateTokens(ledgerText);

    const skeletonHeading = "## Code skeleton";
    const skeleton = buildSkeleton(
      input.skeletonFiles,
      b.skeleton - (input.skeletonFiles.length ? estimateTokens(skeletonHeading) + 1 : 0),
    );
    const skeletonText = skeleton.text ? `${skeletonHeading}\n${skeleton.text}` : "";
    const skeletonUsed = estimateTokens(skeletonText);

    const rollover = Math.max(0, b.ledger - ledgerUsed) + Math.max(0, b.skeleton - skeletonUsed);
    // Input must also stay under the mini's MAX_INPUT_TOKENS ceiling.
    const systemUsed = estimateTokens(systemPrompt);
    const inputCeiling = Math.min(MAX_INPUT_TOKENS, b.total - b.outputBuffer);
    const workingCap = Math.max(
      0,
      Math.min(b.workingSet + rollover, inputCeiling - systemUsed - ledgerUsed - skeletonUsed - 8),
    );

    const workingHeading = "## Working set";
    // The "not shown" note is charged to the working set too.
    const anyFiles = input.workingSet.length + input.skeletonFiles.length > 0;
    const noteCap = anyFiles ? Math.min(OMITTED_NOTE_TOKENS, Math.floor(workingCap / 4)) : 0;
    const working = buildWorkingSet(
      input.workingSet,
      workingCap - noteCap - (input.workingSet.length ? estimateTokens(workingHeading) + 1 : 0),
    );
    const omitted = [...skeleton.omitted, ...working.omitted];

    const sections = [ledgerText, skeletonText, working.text ? `${workingHeading}\n${working.text}` : ""];
    if (omitted.length && noteCap > 0) {
      sections.push(fitText(`Not shown this turn (ask for a path and line range): ${omitted.join(", ")}`, noteCap - 2));
    }
    let prompt = sections.filter(Boolean).join("\n\n");

    // Hard guard: the four-section split plus estimate drift must never
    // push the turn over the input ceiling.
    const maxPrompt = inputCeiling - systemUsed;
    if (estimateTokens(prompt) > maxPrompt) prompt = fitText(prompt, maxPrompt);

    const promptUsed = estimateTokens(prompt);
    const workingUsed = Math.max(0, promptUsed - ledgerUsed - skeletonUsed);
    const inputTokens = systemUsed + promptUsed;
    const usage: PackedTurn["usage"] = {
      ledger: { used: ledgerUsed, cap: b.ledger },
      skeleton: { used: skeletonUsed, cap: b.skeleton },
      workingSet: { used: workingUsed, cap: b.workingSet + rollover, rollover },
      reserve: { used: systemUsed + b.outputBuffer, cap: b.reserve, system: systemUsed, output: b.outputBuffer },
      input: inputTokens,
      total: inputTokens + b.outputBuffer,
      budget: b.total,
    };
    const logLine = formatBudgetLine(input.turn, usage, omitted.length);
    this.log?.(logLine);
    return { systemPrompt, prompt, usage, omitted, logLine };
  }
}

// ---------------------------------------------------------------------------
// Selection (per run / per role) and the RunRequest adapter
// ---------------------------------------------------------------------------

export const CONTEXT_PACKER_MODES = ["claude-code", "l1"] as const;
export type ContextPackerMode = (typeof CONTEXT_PACKER_MODES)[number];

/** ClaudeCodeRunner's existing behaviour stays the default. */
export const DEFAULT_CONTEXT_PACKER: ContextPackerMode = "claude-code";

export function isContextPackerMode(value: unknown): value is ContextPackerMode {
  return typeof value === "string" && (CONTEXT_PACKER_MODES as readonly string[]).includes(value);
}

export interface ContextPackerSelection {
  /** Explicit per-run choice (wins). Unknown values are ignored. */
  run?: unknown;
  /** The active role id, looked up in `roles`. */
  roleId?: string;
  /** Per-role defaults, e.g. { coder: "l1" }. */
  roles?: Record<string, unknown>;
}

/** Run override → role default → "claude-code". */
export function resolveContextPacker(selection: ContextPackerSelection = {}): ContextPackerMode {
  if (isContextPackerMode(selection.run)) return selection.run;
  const roleMode = selection.roleId ? selection.roles?.[selection.roleId] : undefined;
  if (isContextPackerMode(roleMode)) return roleMode;
  return DEFAULT_CONTEXT_PACKER;
}

/**
 * Return a copy of `request` that carries the packed turn:
 *  - prompt ← packed prompt; agentCard ← packed system prompt (which
 *    already folded in the agent card / role prompt / memory);
 *  - memoryContext and the role's appendSystemPrompt are cleared so they
 *    are not appended a second time by buildArgv;
 *  - sessionId is dropped: an L1 turn is stateless, so --resume (which
 *    replays the whole history) would defeat the budget.
 * The role's tool allowlist and MCP config are kept.
 */
export function toPackedRunRequest(request: RunRequest, packed: PackedTurn): RunRequest {
  return {
    ...request,
    prompt: packed.prompt,
    agentCard: packed.systemPrompt,
    memoryContext: undefined,
    sessionId: undefined,
    rolePhase: request.rolePhase ? { ...request.rolePhase, appendSystemPrompt: undefined } : undefined,
  };
}

/** The system extras a RunRequest would have appended, in buildArgv's order. */
export function systemExtrasFrom(request: RunRequest): string[] {
  return [request.agentCard, request.rolePhase?.appendSystemPrompt, request.memoryContext].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
}
