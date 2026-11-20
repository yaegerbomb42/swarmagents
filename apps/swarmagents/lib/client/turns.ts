/**
 * turns.ts — shape one run's events into what a conversation turn shows.
 *
 * A turn is one run: the user's message, then the agent's work. The raw event
 * stream is long (every tool call is a row), so it is folded into blocks: the
 * agent's messages stay as prose, and each stretch of tool calls and status
 * lines between them becomes one collapsible "steps" block. Questions and
 * desktop handoffs stay as their own blocks because the user has to act on
 * them. Pure and DOM-free.
 */

import type { ConversationEntry } from "./conversation";

export type AgentEntry = Extract<ConversationEntry, { kind: "agent" }>;
export type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
export type StatusEntry = Extract<ConversationEntry, { kind: "status" }>;
export type QuestionEntry = Extract<ConversationEntry, { kind: "question" }>;
export type HandoffEntry = Extract<ConversationEntry, { kind: "handoff" }>;
export type StepEntry = ToolEntry | StatusEntry;

export type TurnBlock =
  | { kind: "agent"; key: string; entry: AgentEntry }
  | { kind: "steps"; key: string; steps: StepEntry[] }
  | { kind: "question"; key: string; entry: QuestionEntry }
  | { kind: "handoff"; key: string; entry: HandoffEntry };

/** A question the server still holds open (GET /api/runtime/questions). */
export interface OpenQuestion {
  id: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  createdAt: number;
  expiresAt?: number;
}

/** A desktop handoff the server still holds open (GET /api/runtime/handoffs). */
export interface OpenHandoff {
  id: string;
  reason: string;
  description: string;
  createdAt: number;
  expiresAt?: number;
}

export interface OpenPrompts {
  questions: readonly OpenQuestion[];
  handoffs: readonly OpenHandoff[];
  /** Answers sent from this page, by question id. */
  answers: Readonly<Record<string, string>>;
  /** Handoffs handed back from this page, by id. */
  handedBack: Readonly<Record<string, boolean>>;
}

/**
 * Add the questions and handoffs the server still holds open to the stream's
 * entries (a reload can miss the event that asked them), and apply what the
 * user already answered here so the card flips without waiting for the stream.
 */
export function withOpenPrompts(
  entries: readonly ConversationEntry[],
  prompts: OpenPrompts,
): ConversationEntry[] {
  const questionIds = new Set<string>();
  const handoffIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "question") questionIds.add(entry.id);
    if (entry.kind === "handoff") handoffIds.add(entry.id);
  }

  const extras: ConversationEntry[] = [];
  for (const question of prompts.questions) {
    if (questionIds.has(question.id)) continue;
    questionIds.add(question.id);
    extras.push({
      kind: "question",
      key: `question:${question.id}`,
      ts: question.createdAt,
      id: question.id,
      question: question.question,
      options: question.options,
      allowFreeText: question.allowFreeText,
      status: "pending",
      ...(question.expiresAt !== undefined ? { expiresAt: question.expiresAt } : {}),
    });
  }
  for (const handoff of prompts.handoffs) {
    if (handoffIds.has(handoff.id)) continue;
    handoffIds.add(handoff.id);
    extras.push({
      kind: "handoff",
      key: `handoff:${handoff.id}`,
      ts: handoff.createdAt,
      id: handoff.id,
      reason: handoff.reason,
      description: handoff.description,
      status: "pending",
      ...(handoff.expiresAt !== undefined ? { expiresAt: handoff.expiresAt } : {}),
    });
  }

  const merged = extras.length > 0 ? [...entries, ...extras].sort((a, b) => a.ts - b.ts) : [...entries];
  return merged.map((entry): ConversationEntry => {
    if (entry.kind === "question" && entry.status === "pending") {
      const answer = prompts.answers[entry.id];
      return answer === undefined ? entry : { ...entry, status: "answered", answer };
    }
    if (entry.kind === "handoff" && entry.status === "pending" && prompts.handedBack[entry.id]) {
      return { ...entry, status: "answered" };
    }
    return entry;
  });
}

/**
 * Once a run has ended nothing in it waits on the user. A question or handoff
 * the run left open (it was stopped, or it failed, before the answer) is shown
 * as unanswered, never as something that can still be answered.
 */
export function closeOpenPrompts(entries: readonly ConversationEntry[]): ConversationEntry[] {
  return entries.map((entry): ConversationEntry =>
    (entry.kind === "question" || entry.kind === "handoff") && entry.status === "pending"
      ? { ...entry, status: "cancelled" }
      : entry,
  );
}

/** How many questions and handoffs are still waiting on the user. */
export function countWaitingOnUser(entries: readonly ConversationEntry[]): number {
  let waiting = 0;
  for (const entry of entries) {
    if ((entry.kind === "question" || entry.kind === "handoff") && entry.status === "pending") waiting += 1;
  }
  return waiting;
}

/**
 * Status lines the turn already shows somewhere better: the run's outcome is
 * its footer, and a pending approval is the approval prompt itself.
 */
const SHOWN_ELSEWHERE = /^(finished|cancelled|error|approval):/;

/** Fold a run's entries into the blocks a turn renders, in order. */
export function buildTurnBlocks(entries: readonly ConversationEntry[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let steps: StepEntry[] | null = null;

  for (const entry of entries) {
    if (entry.kind === "user") continue; // the turn renders the prompt itself
    if (entry.kind === "status" && SHOWN_ELSEWHERE.test(entry.key)) continue;

    if (entry.kind === "tool" || entry.kind === "status") {
      if (!steps) {
        steps = [];
        blocks.push({ kind: "steps", key: `steps:${entry.key}`, steps });
      }
      steps.push(entry);
      continue;
    }

    steps = null;
    if (entry.kind === "agent") blocks.push({ kind: "agent", key: entry.key, entry });
    else if (entry.kind === "question") blocks.push({ kind: "question", key: entry.key, entry });
    else blocks.push({ kind: "handoff", key: entry.key, entry });
  }
  return blocks;
}

/** The one line that describes a step. */
export function stepLabel(step: StepEntry): string {
  return step.kind === "tool" ? step.label : step.text;
}

export interface StepsSummary {
  count: number;
  /** A tool call in this block is still running. */
  running: boolean;
  /** Tool calls that failed, plus blocked calls. */
  failed: number;
  /** The step to show while collapsed: the running one, else the last. */
  label: string;
}

export function summarizeSteps(steps: readonly StepEntry[]): StepsSummary {
  let running: StepEntry | undefined;
  let failed = 0;
  for (const step of steps) {
    if (step.kind === "tool") {
      if (step.status === "running") running = step;
      if (step.status === "error") failed += 1;
    } else if (step.tone === "error") {
      failed += 1;
    }
  }
  const shown = running ?? steps[steps.length - 1];
  return {
    count: steps.length,
    running: running !== undefined,
    failed,
    label: shown ? stepLabel(shown) : "",
  };
}

/**
 * What the agent is doing right now, for the run indicator: the tool call in
 * flight, else the most recent step. Undefined before the first step and
 * while the agent is writing prose.
 */
export function currentActivity(entries: readonly ConversationEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "tool" && entry.status === "running") return entry.label;
  }
  const last = entries[entries.length - 1];
  if (!last) return undefined;
  if (last.kind === "tool") return last.label;
  if (last.kind === "status" && !SHOWN_ELSEWHERE.test(last.key)) return last.text;
  if (last.kind === "question") return "Waiting for your answer";
  if (last.kind === "handoff") return "Waiting for you on the desktop";
  return undefined;
}

/** "640 ms" / "1.2 s" for a tool call's duration. */
export function formatStepDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A thread title from a prompt: its first line, clipped. */
export function titleFromPrompt(prompt: string | undefined, max = 60): string {
  const firstLine = (prompt ?? "").split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
