/**
 * F13 — Playbook recorder.
 *
 * Captures a manual desktop / Playwright / shell trace and compiles it into
 * a Library skill. Recorded literals become parameters. Each step inherits
 * a PreToolUse bound from the harness risk classifier; replay re-checks the
 * substituted call and refuses anything the classifier denies.
 */

import { spawnSync } from "node:child_process";
import { classifyToolCall, type RiskDecision, type RiskLevel } from "../harness/risk";
import { addInstalledItem, type LibraryStoreOptions } from "../library/user-store";
import type { SecretField, SkillPayload } from "../library/types";

export type TraceSource = "shell" | "playwright" | "desktop";

export interface TraceStep {
  source: TraceSource;
  tool: string;
  input: Record<string, unknown>;
}

export interface PlaybookParameter {
  key: string;
  label: string;
  /** The literal observed while recording. Never written into the skill body. */
  example: string;
  secret: boolean;
}

export interface StepBound {
  index: number;
  tool: string;
  level: RiskLevel;
  reason: string;
}

export interface CompiledPlaybook {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  bounds: StepBound[];
  /** Strictest bound across the trace. */
  maxLevel: RiskLevel;
  steps: TraceStep[];
  payload: SkillPayload;
}

const LEVEL_RANK: Record<RiskLevel, number> = { allow: 0, ask: 1, deny: 2 };

const SECRET_KEY_RE = /(pass(word)?|secret|token|api[_-]?key|credential)/i;

export class PlaybookRecorder {
  private readonly steps: TraceStep[] = [];

  recordShell(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("shell trace step is empty");
    this.steps.push({ source: "shell", tool: "Bash", input: { command: trimmed } });
  }

  recordPlaywright(tool: string, input: Record<string, unknown>): void {
    this.steps.push({ source: "playwright", tool: normalizeMcpTool(tool, "playwright-mcp"), input: { ...input } });
  }

  recordDesktop(tool: string, input: Record<string, unknown>): void {
    this.steps.push({ source: "desktop", tool: normalizeMcpTool(tool, "computer-mcp"), input: { ...input } });
  }

  trace(): TraceStep[] {
    return this.steps.map((step) => ({ ...step, input: { ...step.input } }));
  }
}

function normalizeMcpTool(tool: string, server: string): string {
  const name = tool.trim();
  if (!name) throw new Error("trace tool name is empty");
  if (name.startsWith("mcp__")) return name;
  return `mcp__${server}__${name}`;
}

interface ParamBag {
  parameters: PlaybookParameter[];
  byLiteral: Map<string, PlaybookParameter>;
  secrets: SecretField[];
}

function addParam(bag: ParamBag, literal: string, label: string, secret: boolean): string {
  const existing = bag.byLiteral.get(literal);
  if (existing) return `{{${existing.key}}}`;
  const key = secret ? `secret_${bag.parameters.length + 1}` : `param_${bag.parameters.length + 1}`;
  const parameter: PlaybookParameter = { key, label, example: literal, secret };
  bag.parameters.push(parameter);
  bag.byLiteral.set(literal, parameter);
  if (secret) bag.secrets.push({ key, label });
  return `{{${key}}}`;
}

function parameterizeString(value: string, bag: ParamBag, keyHint: string): string {
  let out = value;
  if (SECRET_KEY_RE.test(keyHint) && value.length > 0 && !value.includes("{{")) {
    return addParam(bag, value, keyHint, true);
  }
  out = out.replace(/((?:--)?(?:password|passwd|secret|token|api[_-]?key)=)(\S+)/gi, (_match, prefix: string, literal: string) => {
    return `${prefix}${addParam(bag, literal, "secret", true)}`;
  });
  out = out.replace(/https?:\/\/[^\s"'`<>]+/g, (literal) => addParam(bag, literal, "url", false));
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (literal) => addParam(bag, literal, "email", false));
  return out;
}

function parameterizeValue(value: unknown, bag: ParamBag, keyHint: string): unknown {
  if (typeof value === "string") return parameterizeString(value, bag, keyHint);
  if (Array.isArray(value)) return value.map((item, index) => parameterizeValue(item, bag, `${keyHint}_${index}`));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = parameterizeValue(child, bag, key);
    }
    return out;
  }
  return value;
}

function boundFor(tool: string, input: Record<string, unknown>): RiskDecision {
  if (tool === "Bash" && typeof input.command === "string") {
    return classifyToolCall("Bash", { command: input.command });
  }
  return classifyToolCall(tool, input);
}

export function compileTrace(
  steps: readonly TraceStep[],
  options: { name: string; description?: string },
): CompiledPlaybook {
  if (steps.length === 0) throw new Error("cannot compile an empty trace");
  const name = options.name.trim();
  if (!name) throw new Error("playbook name is required");
  const bag: ParamBag = { parameters: [], byLiteral: new Map(), secrets: [] };
  const templated: TraceStep[] = steps.map((step) => ({
    source: step.source,
    tool: step.tool,
    input: parameterizeValue(step.input, bag, "") as Record<string, unknown>,
  }));
  const bounds: StepBound[] = steps.map((step, index) => {
    const decision = boundFor(step.tool, step.input);
    return { index, tool: step.tool, level: decision.level, reason: decision.reason };
  });
  const maxLevel = bounds.reduce<RiskLevel>((strictest, bound) => {
    return LEVEL_RANK[bound.level] > LEVEL_RANK[strictest] ? bound.level : strictest;
  }, "allow");
  const description = options.description?.trim() || `Recorded workflow (${steps.length} steps).`;
  const payload: SkillPayload = {
    kind: "skill",
    skillMd: renderSkillMd({ name, description, parameters: bag.parameters, bounds, steps: templated, maxLevel }),
    files: [
      {
        path: "playbook.json",
        content: JSON.stringify({ steps: templated, bounds, parameters: bag.parameters.map(({ key, label, secret }) => ({ key, label, secret })) }, null, 2),
      },
    ],
    requiredFields: bag.secrets,
  };
  return { name, description, parameters: bag.parameters, bounds, maxLevel, steps: templated, payload };
}

function renderSkillMd(playbook: Omit<CompiledPlaybook, "payload">): string {
  const params = playbook.parameters
    .map((parameter) => `- \`${parameter.key}\` (${parameter.secret ? "secret" : "parameter"}): ${parameter.label}`)
    .join("\n");
  const steps = playbook.steps
    .map((step, index) => {
      const bound = playbook.bounds[index];
      return `${index + 1}. \`${step.tool}\` — PreToolUse \`${bound?.level}\` (${bound?.reason}). Input: \`${JSON.stringify(step.input)}\``;
    })
    .join("\n");
  return [
    "---",
    `name: ${playbook.name}`,
    `preToolUseMax: ${playbook.maxLevel}`,
    "---",
    "",
    `# ${playbook.name}`,
    "",
    playbook.description,
    "",
    "## Parameters",
    "",
    params || "_None — the trace had no substitutable literals._",
    "",
    "## Steps",
    "",
    steps,
    "",
    "## Safety",
    "",
    "Replay must call the harness risk classifier on each substituted step. A `deny` bound blocks the step. An `ask` bound requires approval before the tool runs. Recorded literals are parameters, not hardcoded values.",
    "",
  ].join("\n");
}

export function substitute(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
      const replacement = params[key];
      if (replacement === undefined) throw new Error(`missing playbook parameter ${key}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(child, params);
    return out;
  }
  return value;
}

export interface PlaybookRunStep {
  tool: string;
  input: Record<string, unknown>;
  decision: RiskDecision;
  executed: boolean;
  output?: string;
}

export interface PlaybookRunResult {
  steps: PlaybookRunStep[];
  output: string;
}

/**
 * Replay a compiled playbook. Shell steps the classifier allows may run
 * locally (`exec: true`). Denied steps throw. Ask steps are returned and
 * not executed.
 */
export function runCompiledPlaybook(
  playbook: CompiledPlaybook,
  params: Record<string, string>,
  options: { exec?: boolean; cwd?: string } = {},
): PlaybookRunResult {
  const ran: PlaybookRunStep[] = [];
  const chunks: string[] = [];
  for (const step of playbook.steps) {
    const input = substitute(step.input, params) as Record<string, unknown>;
    const decision = boundFor(step.tool, input);
    if (decision.level === "deny") {
      throw new Error(`PreToolUse deny: ${decision.reason}`);
    }
    const executable = options.exec === true && decision.level === "allow" && step.tool === "Bash" && typeof input.command === "string";
    let output: string | undefined;
    if (executable) {
      const result = spawnSync("bash", ["-lc", input.command as string], {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" } satisfies NodeJS.ProcessEnv,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || `playbook step exited ${result.status}`);
      }
      output = (result.stdout ?? "").trim();
      chunks.push(output);
    }
    ran.push({ tool: step.tool, input, decision, executed: executable, output });
  }
  return { steps: ran, output: chunks.filter(Boolean).join("\n") };
}

/** Install the compiled skill into the caller's Library. */
export function savePlaybookToLibrary(
  userId: string,
  playbook: CompiledPlaybook,
  options: LibraryStoreOptions = {},
) {
  return addInstalledItem(
    userId,
    {
      kind: "skill",
      name: playbook.name,
      description: playbook.description,
      origin: "user",
      payload: playbook.payload,
    },
    options,
  );
}
