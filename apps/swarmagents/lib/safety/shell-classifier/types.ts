import { z } from "zod";

export const RiskLevelSchema = z.enum(["safe", "review", "block"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ClassifierRoleSchema = z.object({
  allowBash: z.boolean(),
  allowWrite: z.boolean(),
  allowNetwork: z.boolean(),
  readOnly: z.boolean(),
});
export type ClassifierRole = z.infer<typeof ClassifierRoleSchema>;

export const ClassifyInputSchema = z.object({
  command: z.string(),
  cwd: z.string().min(1),
  role: ClassifierRoleSchema,
  workspaceRoot: z.string().min(1).default("/workspace"),
  allowlistedHosts: z.array(z.string()).optional(),
  homeDir: z.string().min(1).optional(),
});
export type ClassifyInput = z.input<typeof ClassifyInputSchema>;
export type ParsedClassifyInput = z.output<typeof ClassifyInputSchema>;

export const ClassifyOutputSchema = z.object({
  risk: RiskLevelSchema,
  reasons: z.array(z.string()),
  categories: z.array(z.string()),
  normalized: z.string(),
  touchesPaths: z.array(z.string()),
  networkTargets: z.array(z.string()),
});
export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

export type OperatorKind =
  | ";"
  | "&&"
  | "||"
  | "|"
  | "|&"
  | "&"
  | "\n"
  | "("
  | ")"
  | "{"
  | "}";

export type RedirectOp =
  | ">"
  | ">>"
  | ">|"
  | "<"
  | "<>"
  | "<<"
  | "<<-"
  | "<<<"
  | "&>"
  | "&>>"
  | ">&"
  | "<&";

export interface WordToken {
  raw: string;
  value: string;
  hasQuotes: boolean;
  singleQuoted: boolean;
  midWordQuoted: boolean;
  hasExpansion: boolean;
  hasHexOrOctalEscape: boolean;
  subcommands: string[];
  variables: string[];
}

export type LexToken =
  | { type: "word"; word: WordToken }
  | { type: "op"; op: OperatorKind }
  | {
      type: "redirect";
      fd?: number;
      op: RedirectOp;
      target: WordToken;
      heredocBody?: string;
    };

export interface EnvAssignment {
  name: string;
  value: WordToken;
}

export interface RedirectNode {
  fd?: number;
  op: RedirectOp;
  target: WordToken;
  heredocBody?: string;
}

export interface SimpleCommandNode {
  kind: "simple";
  envAssignments: EnvAssignment[];
  argv: WordToken[];
  redirects: RedirectNode[];
}

export interface SubshellCommandNode {
  kind: "subshell" | "group";
  pipelines: PipelineNode[];
  redirects: RedirectNode[];
}

export interface FunctionDefNode {
  kind: "function";
  name: string;
  body: CommandNode;
}

export type CommandNode =
  | SimpleCommandNode
  | SubshellCommandNode
  | FunctionDefNode;

export interface PipelineSegment {
  command: CommandNode;
  pipeOp?: "|" | "|&";
}

export interface PipelineNode {
  negated: boolean;
  segments: PipelineSegment[];
  terminator?: ";" | "&&" | "||" | "&" | "\n";
}

export interface Finding {
  risk: RiskLevel;
  category: string;
  reason: string;
}

export interface AnalysisContext {
  cwd: string;
  workspaceRoot: string;
  homeDir: string;
  role: ClassifierRole;
  allowlistedHosts: Set<string>;
  allowlistedWildcards: string[];
  depth: number;
  vars: Map<string, string>;
  findings: Finding[];
  touchesPaths: Set<string>;
  networkTargets: Set<string>;
}
