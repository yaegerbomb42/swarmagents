/**
 * The five System-1 gates, ported from Omnexx
 * (vendor/omnexx/src/runtime/system-one/{guardrail,patch-sanity,output-triage,
 * continuation,intent-router}.ts) and adapted to Claude Code's tool names
 * (Bash, Edit, MultiEdit, Write, Read, Grep, Glob, LS…).
 *
 * Each gate takes a SystemOneScorer and applies the calibrated features as
 * a floor, so a remote scorer can make a gate stricter but never talk it
 * out of a dangerous command or an error line.
 *
 * Nothing here touches the filesystem or network directly: the caller
 * injects `readFile` (patch-sanity for Write) and `search` (speculation),
 * which in production run through the VM exec.
 */

import {
  destructiveProb,
  hasErrorLine,
  patchSignals,
  placeholderProb,
  type ContinuationState,
  type IntentClass,
  type TriageClass,
} from "./features";
import type { GuardrailInput, SystemOneScorer } from "./scorer";

// ---------------------------------------------------------------------------
// Gate 1: guardrail (Bash)
// ---------------------------------------------------------------------------

export interface GuardrailVerdict {
  prob: number;
  destructive: boolean;
}

export async function assessCommand(
  scorer: SystemOneScorer,
  input: GuardrailInput,
  threshold: number,
): Promise<GuardrailVerdict> {
  const remote = await scorer.destructive(input);
  // The calibrated features are a floor: a model can't talk the gate out of `rm -rf /`.
  const floor = destructiveProb(input.command, input.cwd, input.repoRoot, input.allowOutsideRepo);
  // A misbehaving scorer must not push the probability outside [0, 1].
  const remoteProb = Number.isFinite(remote) ? Math.min(1, Math.max(0, remote)) : 0;
  const prob = Math.max(remoteProb, floor);
  return { prob, destructive: prob > threshold };
}

export const commandPreview = (command: string): string =>
  command.length > 120 ? `${command.slice(0, 117)}...` : command;

export function guardrailReason(prob: number): string {
  return `System-1 flags this command as destructive, unrecoverable or out of scope (prob ${prob.toFixed(2)}). Approve only if you intend it; a reversible alternative (git stash, a new branch, a scoped path, a dry run) is safer.`;
}

// ---------------------------------------------------------------------------
// Gate 5: patch sanity (Edit / MultiEdit / Write)
// ---------------------------------------------------------------------------

export interface Patch {
  path: string;
  oldText: string;
  newText: string;
}

const rec = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
const str = (x: unknown): string => (typeof x === "string" ? x : "");

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * What a Claude Code edit tool call would replace, and with what. For
 * Write the old text is the file's current content (via `readFile`; a
 * missing file is a new file, old text ""). Undefined for other tools.
 */
export async function patchOf(
  name: string,
  input: unknown,
  readFile?: (path: string) => Promise<string>,
): Promise<Patch | undefined> {
  const i = rec(input);
  const path = str(i.file_path) || str(i.path);
  if (!path) return undefined;
  if (name === "Edit") return { path, oldText: str(i.old_string), newText: str(i.new_string) };
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    const edits = i.edits.map(rec);
    return {
      path,
      oldText: edits.map((e) => str(e.old_string)).join("\n"),
      newText: edits.map((e) => str(e.new_string)).join("\n"),
    };
  }
  if (name === "Write") {
    let oldText = "";
    try {
      oldText = readFile ? await readFile(path) : "";
    } catch {
      oldText = "";
    }
    return { path, oldText, newText: str(i.content) };
  }
  return undefined;
}

export interface PatchVerdict {
  reject: boolean;
  placeholderProb: number;
  completeness: number;
  confidence: number;
  placeholders: string[];
  droppedCodeLines: number;
}

const PATCH_SLICE = 12_000;

export async function assessPatch(scorer: SystemOneScorer, patch: Patch, threshold: number): Promise<PatchVerdict> {
  const clipped = { path: patch.path, oldText: patch.oldText.slice(0, PATCH_SLICE), newText: patch.newText.slice(0, PATCH_SLICE) };
  const r = await scorer.patch(clipped);
  const sig = patchSignals(patch.oldText, patch.newText);
  // Placeholders that replace no real code (new docs, tests about comments) never count; when
  // real code did go missing, the calibrated features are a floor under the scorer's answer.
  const prob = sig.droppedCodeLines > 0 ? Math.max(r.placeholderProb, placeholderProb(sig)) : Math.min(r.placeholderProb, 0.2);
  const reject = prob > threshold || (r.completeness < 2 && r.confidence >= 0.8);
  return {
    reject,
    placeholderProb: prob,
    completeness: r.completeness,
    confidence: r.confidence,
    placeholders: sig.placeholders,
    droppedCodeLines: sig.droppedCodeLines,
  };
}

export function patchRejection(path: string, v: PatchVerdict): string {
  const what = v.placeholders.length
    ? `it replaces ${v.droppedCodeLines} line(s) of existing code with placeholder comment(s) ${v.placeholders
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(", ")}`
    : `it looks truncated (completeness ${v.completeness}/5)`;
  return `[system1:patch-sanity] Rejected before writing ${path}: ${what} (placeholder prob=${v.placeholderProb.toFixed(2)}). Nothing was written. Re-send the edit with the complete code, keeping every line you meant to keep.`;
}

// ---------------------------------------------------------------------------
// Gate 3: output triage (long Bash output)
// ---------------------------------------------------------------------------

const MIN_LINES = 40;
const MIN_CHARS = 2_000;
const CHUNK_LINES = 20;
const MAX_CHUNKS = 24;

export function needsTriage(output: string): boolean {
  return output.length > MIN_CHARS || output.split("\n").length > MIN_LINES;
}

export function chunkLines(lines: readonly string[]): string[][] {
  const size = Math.max(CHUNK_LINES, Math.ceil(lines.length / MAX_CHUNKS));
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
  return out;
}

function renderTriage(chunks: readonly string[][], classes: readonly TriageClass[]): { text: string; pruned: number; warnings: number } {
  const groups: { cls: TriageClass; lines: string[] }[] = [];
  chunks.forEach((lines, i) => {
    const cls = classes[i] ?? "relevant_error_trace";
    const prev = groups.at(-1);
    if (prev?.cls === cls) prev.lines.push(...lines);
    else groups.push({ cls, lines: [...lines] });
  });
  const out: string[] = [];
  let pruned = 0;
  let warnings = 0;
  groups.forEach(({ cls, lines }, i) => {
    // The last two lines of the whole output (exit codes, "added N packages", test totals)
    // are always kept — a change from Omnexx, which dropped them inside a warnings group.
    const keepTail = i === groups.length - 1 ? 2 : 0;
    if (cls === "relevant_error_trace") out.push(...lines);
    else if (cls === "harmless_warnings") {
      const collapsed = Math.max(0, lines.length - keepTail);
      if (collapsed < 3) out.push(...lines);
      else {
        out.push(`[system1:triage collapsed ${collapsed} warning lines]`, ...(keepTail ? lines.slice(-keepTail) : []));
        warnings += collapsed;
      }
    } else {
      // Keep the head, and the tail of the final group.
      const dropped = Math.max(0, lines.length - 1 - keepTail);
      if (dropped < 3) out.push(...lines);
      else {
        out.push(lines[0] ?? "", `[system1:triage pruned ${dropped} noise lines]`, ...(keepTail ? lines.slice(-keepTail) : []));
        pruned += dropped;
      }
    }
  });
  return { text: out.join("\n"), pruned, warnings };
}

export interface TriageResult {
  content: string;
  changed: boolean;
  linesPruned: number;
  warningLines: number;
  /** Rough tokens saved (chars / 4, Omnexx's estimate). */
  tokensSaved: number;
}

export async function triageOutput(scorer: SystemOneScorer, output: string, tool: string): Promise<TriageResult> {
  const chunks = chunkLines(output.split("\n"));
  const texts = chunks.map((c) => c.join("\n"));
  const remote = await scorer.triage(texts, tool);
  // Never drop a chunk the calibrated features see an error in.
  const classes = texts.map((t, i): TriageClass => (hasErrorLine(t) ? "relevant_error_trace" : (remote[i] ?? "relevant_error_trace")));
  const { text, pruned, warnings } = renderTriage(chunks, classes);
  const changed = pruned > 0 || warnings > 0;
  const tokens = (s: string) => Math.ceil(s.length / 4);
  return {
    content: changed ? text : output,
    changed,
    linesPruned: pruned,
    warningLines: warnings,
    tokensSaved: changed ? Math.max(0, tokens(output) - tokens(text)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Gate 2: continuation / early stop
// ---------------------------------------------------------------------------

export interface TurnCall {
  name: string;
  input: unknown;
  isError: boolean;
}

const VERIFY = [
  /\b(?:vitest|jest|pytest|mocha|tsc|eslint)\b/,
  /\bprettier\s+--check\b/,
  /\bcargo\s+(?:test|check|clippy)\b/,
  /\bgo\s+(?:test|vet)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build|format:check)\b/,
  /\bnpx\s+(?:tsc|eslint|vitest|jest|tsx\s+--test)\b/,
  /\bnode\s+--test\b/,
];
const INSPECT = /^\s*(?:ls|cat|head|tail|wc|pwd|tree|find|stat|git\s+(?:status|diff|log|show|branch)|rg|grep)\b/;

/** Claude Code tools that never change the workspace. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
]);

type Kind = "verify" | "inspect" | "mutate";

function kindOf(c: TurnCall): Kind {
  if (c.name === "Bash") {
    const cmd = str(rec(c.input).command);
    if (VERIFY.some((re) => re.test(cmd))) return "verify";
    return INSPECT.test(cmd) ? "inspect" : "mutate";
  }
  // Unknown tools (MCP, etc.) count as mutations: conservative, they reset the tracker.
  return READ_ONLY_TOOLS.has(c.name) ? "inspect" : "mutate";
}

const STARTING_OR_INCOMPLETE = /\b(let me|i will|i'll start|let's start|i need to|first,|step 1|shall i|plan:)\b/i;
const WANTS_EDITS = /\b(implement|create|add|convert|update|fix|refactor|delete|write|modify|edit|build|install)\b/i;

/** Follows the loop's trace: edits, verification results, and read-only churn after green. */
export class ContinuationTracker {
  readonly filesModified = new Set<string>();
  private green = false;
  private failed = false;
  private errorsLastTurn = false;
  redundantReadOnly = 0;
  /**
   * The latest substantive assistant text (≥80 chars). Omnexx judged each
   * turn by its own text only, so an answer followed by short "checking X"
   * turns never counted as answered; remembering it fixes that.
   */
  lastSubstantive = "";

  record(calls: readonly TurnCall[], assistantSummary: string): void {
    this.errorsLastTurn = false;
    if (assistantSummary.trim().length >= 80) this.lastSubstantive = assistantSummary.trim();
    for (const c of calls) this.recordOne(c, this.lastSubstantive);
  }

  private recordOne(c: TurnCall, summary: string): void {
    const kind = kindOf(c);
    if (kind === "verify") {
      if (c.isError) {
        this.failed = true;
        this.green = false;
        this.redundantReadOnly = 0;
      } else {
        if (this.green) this.redundantReadOnly++;
        this.green = true;
        this.failed = false;
      }
    } else if (c.isError) this.errorsLastTurn = true;
    else if (kind === "mutate") {
      const p = str(rec(c.input).file_path) || str(rec(c.input).path);
      this.filesModified.add(p || (c.name === "Bash" ? "(shell)" : `(${c.name})`));
      this.green = false;
      this.failed = false;
      this.redundantReadOnly = 0;
    } else if (this.green || (this.filesModified.size === 0 && summary.length >= 200)) this.redundantReadOnly++;
  }

  /** Only ask System-1 once the work is verified (or answered) and the loop is re-inspecting. */
  eligible(assistantSummary: string, prompt?: string): boolean {
    if (this.failed || this.errorsLastTurn || this.redundantReadOnly < 2) return false;
    if (STARTING_OR_INCOMPLETE.test(assistantSummary)) return false;
    if (prompt && WANTS_EDITS.test(prompt) && this.filesModified.size === 0) return false;
    return this.filesModified.size > 0 ? this.green : this.lastSubstantive.length >= 200;
  }

  state(prompt: string, _assistantSummary?: string): ContinuationState {
    return {
      prompt: prompt.slice(0, 2_000),
      filesModified: this.filesModified.size,
      testsPassed: this.green,
      testsFailed: this.failed,
      redundantReadOnly: this.redundantReadOnly,
      pendingCalls: 0,
      assistantSummary: this.lastSubstantive.slice(0, 2_000),
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 4: intent + speculative prefetch
// ---------------------------------------------------------------------------

const STOP = new Set(
  "the and are for how was were its you all not but has can show where what which when does that this with from into about there their have make code file files find look tell explain please could would should them they used uses work works check checked handle handled defined implemented called repo project function functions".split(
    " ",
  ),
);

/** Search terms from a prompt: identifiers and content words, singularized, most specific first. */
export function searchTerms(prompt: string): string[] {
  const words = prompt.match(/[A-Za-z_]\w{2,}/g) ?? [];
  const seen = new Set<string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (STOP.has(lower) || lower.length < 3) continue;
    seen.add(lower.length > 4 && lower.endsWith("s") ? lower.slice(0, -1) : lower);
  }
  return [...seen].slice(0, 5);
}

const MAX_HITS = 25;

/** Rank `path:line:text` hits by how many distinct terms they mention. */
export function rankHits(raw: string, terms: readonly string[]): string[] {
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ l: l.length > 200 ? `${l.slice(0, 197)}...` : l, n: terms.filter((t) => l.toLowerCase().includes(t)).length }))
    .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l))
    .slice(0, MAX_HITS)
    .map((x) => x.l);
}

/**
 * Runs a read-only command (argv, no shell) in the repo and returns stdout.
 * Should resolve "" (not reject) for "no matches".
 */
export type SearchRunner = (argv: string[]) => Promise<string>;

/** Read-only prefetch for an investigative intent; undefined when there is nothing to add. */
export async function speculate(intent: IntentClass, prompt: string, run: SearchRunner): Promise<string | undefined> {
  if (intent === "explain_code") {
    const terms = searchTerms(prompt);
    if (!terms.length) return undefined;
    const pattern = terms.join("|");
    let raw = "";
    try {
      raw = await run(["rg", "-n", "-i", "-S", "--max-count", "5", "--max-columns", "200", "-g", "!node_modules", "-g", "!dist", "-g", "!*.lock", "-e", pattern]);
    } catch {
      raw = await run(["git", "grep", "-n", "-i", "-E", pattern]).catch(() => "");
    }
    const hits = rankHits(raw, terms);
    return hits.length ? `search for ${terms.join(", ")} (${hits.length} best hits):\n${hits.join("\n")}` : undefined;
  }
  if (intent === "git_operation") {
    const [status, stat] = await Promise.all([
      run(["git", "status", "-sb"]).catch(() => ""),
      run(["git", "diff", "--stat"]).catch(() => ""),
    ]);
    const body = [status.trim() && `$ git status -sb\n${status.trim()}`, stat.trim() && `$ git diff --stat\n${stat.trim()}`]
      .filter(Boolean)
      .join("\n\n");
    return body ? body.split("\n").slice(0, 60).join("\n") : undefined;
  }
  return undefined;
}

export function speculativeBlock(intent: IntentClass, confidence: number, findings: string): string {
  return `[system1:speculative ${intent} · ${Math.round(confidence * 100)}%] Already gathered before your first turn (read-only); use it instead of re-running the same search:\n${findings}`;
}
