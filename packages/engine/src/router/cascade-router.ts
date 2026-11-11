/**
 * Deterministic 3-tier model cascade router.
 *
 * The decision is a pure, synchronous classification: regex rules plus a token-count
 * threshold, no model call and no embedding lookup. That keeps the fast path O(1) and lets
 * callers route before they build a prompt.
 *
 *   Tier 1 — no LLM: reads, listings, search, git queries, static lint/format checks.
 *   Tier 2 — fast/cheap model: one-function edits, test-output parsing, isolated bugfixes.
 *   Tier 3 — frontier model: cross-module/architectural work, differential TDR,
 *            security/auth/payments, database migrations, large-context synthesis.
 */

export type CascadeTier = 1 | 2 | 3;

export interface CascadeRoute {
  tier: CascadeTier;
  modelSuggested: string;
  reason: string;
}

/** Tier 1 runs without a model; the other tiers use the project's cheap/frontier aliases. */
export const TIER_MODELS: Readonly<Record<CascadeTier, string>> = {
  1: 'deterministic',
  2: 'anthropic:haiku',
  3: 'anthropic:sonnet',
};

/** Above this prompt/context size a task is too large for a cheap tier-2 pass. */
export const LARGE_CONTEXT_TOKENS = 100_000;

/** Phase 4.4 circuit breaker: consecutive attempts before escalating a tier. */
export const MAX_CALLS_PER_TIER = 2;

const FAST_READ_RE =
  /^\s*(?:please\s+|can you\s+|could you\s+)?(?:read|open|show|display|print|cat|view|inspect|list|ls|tree|head|tail|wc|stat)\b/i;
const SEARCH_RE = /^\s*(?:please\s+)?(?:grep|rg|ripgrep|ag|ack|search|find|locate|glob)\b/i;
const DIRECT_SEARCH_RE = /^\s*(?:please\s+)?(?:grep|rg|ripgrep|ag|ack)\b/i;
const SEARCH_TARGET_RE =
  /\b(?:file|files|directory|directories|folder|path|pattern|symbol|symbols|reference|references|usage|usages|definition|definitions|code|repo|repository|src|test|tests)\b|\.(?:[cm]?[jt]sx?|mts|cts|pyi?|go|rs|java|kt|rb|cs|swift|php|md|json|ya?ml|toml)\b/i;
const GIT_QUERY_RE =
  /^\s*(?:please\s+)?git\s+(?:status|log|diff|show|branch|remote|blame|rev-parse|describe|ls-files|grep|stash\s+list)\b/i;
const STATIC_CHECK_RE =
  /^\s*(?:please\s+)?(?:run\s+)?(?:eslint\b|prettier\b[\s\S]*--check|ruff\s+check\b|clippy\b|cargo\s+clippy\b|lint\b|typecheck\b|type-check\b|tsc\b|gofmt\s+-l\b|rustfmt\b[\s\S]*--check|biome\s+(?:lint|check)\b|npm\s+run\s+(?:lint|typecheck|type-check|format:check)\b|pnpm\s+(?:run\s+)?(?:lint|typecheck|type-check|format:check)\b|yarn\s+(?:run\s+)?(?:lint|typecheck|type-check|format:check)\b|bun\s+(?:run\s+)?(?:lint|typecheck|format:check)\b)/i;
const FORMAT_RE =
  /^\s*(?:please\s+)?(?:run\s+)?(?:(?:prettier|gofmt\b(?!\s+-l)|rustfmt|ruff\s+format|black\b|biome\s+format|dprint)\b|format\s+(?:the\s+|this\s+|all\s+)?(?:files?|code|source|src|repo(?:sitory)?|project|module|changes?)\b)/i;
const ANCHOR_RE =
  /^\s*(?:please\s+)?(?:(?:show|list|get|find)\s+(?:me\s+)?(?:the\s+)?(?:anchors?|outline|symbols?|references?)\b|(?:anchors?|outline|symbols?)\b)/i;

/**
 * A non-formatting mutation. Read verbs win only when no part of the prompt asks for a write,
 * so "read the auth module and fix it" never takes the deterministic path.
 */
const MUTATION_RE =
  /\b(?:fix|fixing|change|update|modify|edit|write|add|remove|rm|mv|replace|delete|create|implement|refactor|rename|migrate|build|debug|repair|patch|optimize|optimise|improve|design|rewrite|generate|apply|ship)\b/i;

interface TierRule {
  re: RegExp;
  reason: string;
}

const TIER3_RULES: readonly TierRule[] = [
  {
    re: /\b(?:architecture|architectural|system design)\b/i,
    reason: 'architectural synthesis',
  },
  {
    re: /\b(?:design|redesign|refactor|migrate|restructure|implement|overhaul|architect|synthesize|synthesise)\b[\s\S]*\b(?:architecture|architectural|system design|distributed system)\b/i,
    reason: 'architectural synthesis',
  },
  { re: /\bcross[- ](?:module|file|cutting|service|package)\b/i, reason: 'cross-module change' },
  {
    re: /\b(?:multi|many)[- ](?:module|file|service|package)s?\b/i,
    reason: 'multi-file change',
  },
  {
    re: /\b(?:codebase|repo(?:sitory)?|project|monorepo)[- ]wide\b/i,
    reason: 'repository-wide change',
  },
  {
    re: /\b(?:refactor|restructure|rewrite|redesign|migrate)\b[\s\S]*\b(?:across|entire|whole|codebase|repo(?:sitory)?|all (?:files|modules)|multiple (?:files|modules))\b/i,
    reason: 'refactor across modules',
  },
  {
    re: /\b(?:auth|authentication|authorization|oauth2?|jwt|saml|sso|security|encryption|cryptography|vulnerabilit(?:y|ies))\b/i,
    reason: 'security/auth-sensitive change',
  },
  {
    re: /\b(?:payment|billing|checkout|pci(?:-dss)?|financial)\b/i,
    reason: 'payments/financial-sensitive change',
  },
  {
    re: /\b(?:database|db)\s+(?:schema|migration|migrations)\b|\bschema\s+migration\b/i,
    reason: 'database schema migration',
  },
  {
    re: /\b(?:distributed|consensus|raft|paxos|sharding|replication|eventual consistency)\b/i,
    reason: 'distributed-systems reasoning',
  },
  {
    re: /\b(?:concurrency|race condition|deadlock|thread[- ]safe|async race)\b/i,
    reason: 'concurrency reasoning',
  },
  {
    re: /\b(?:differential|tdr|root[- ]cause analysis|deep dive|synthesize|synthesise|orchestrat(?:e|ion))\b/i,
    reason: 'differential root-cause synthesis',
  },
  {
    re: /\b(?:entire|whole|full)\s+(?:codebase|repository|repo|project)\b/i,
    reason: 'repository-wide scope',
  },
  {
    re: /\b(?:performance|latency|throughput|scalab(?:ility|le))\b[\s\S]*\b(?:optimi[sz]e|improve|redesign|fix|profile)\b/i,
    reason: 'performance optimization',
  },
];

const TIER2_RULES: readonly TierRule[] = [
  {
    re: /\b(?:fix|bugfix|patch|repair|resolve|debug)\b/i,
    reason: 'isolated bugfix',
  },
  {
    re: /\b(?:stack ?trace|traceback|error output|test output|parse|parsing)\b/i,
    reason: 'test-output/error parsing',
  },
  {
    re: /\b(?:unit test|tests?|spec|assertion|coverage)\b/i,
    reason: 'targeted test work',
  },
  {
    re: /\b(?:rename|typo|tweak|adjust|small|localized|localised|isolated|single[- ]file)\b/i,
    reason: 'small localized edit',
  },
  {
    re: /\b(?:function|method|class|component|module)\b/i,
    reason: 'single-function/module edit',
  },
  {
    re: /\b(?:add|update|modify|change|edit|implement)\b/i,
    reason: 'targeted edit',
  },
];

const FILE_RE =
  /\b[\w@./-]+\.(?:[cm]?[jt]sx?|mts|cts|pyi?|go|rs|java|kt|kts|rb|cs|cpp|cc|cxx|h|hpp|swift|php|scala|md|jsonc?|ya?ml|toml|sql|sh|bash|zsh)\b/gi;

/** More distinct files than this means the change spans modules. */
const MAX_SINGLE_MODULE_FILES = 3;

function fastPathReason(prompt: string): string | undefined {
  const mutates = MUTATION_RE.test(prompt);
  if (GIT_QUERY_RE.test(prompt) && !mutates) return 'read-only git query';
  if (STATIC_CHECK_RE.test(prompt) && !mutates) return 'static lint/type check';
  if (FORMAT_RE.test(prompt) && !mutates) return 'deterministic format pass';
  if (ANCHOR_RE.test(prompt) && !mutates) return 'symbol/anchor lookup';
  if (FAST_READ_RE.test(prompt) && !mutates) return 'file read/list';
  if (SEARCH_RE.test(prompt) && !mutates) {
    if (DIRECT_SEARCH_RE.test(prompt) || SEARCH_TARGET_RE.test(prompt)) {
      return 'search/reconnaissance';
    }
  }
  return undefined;
}

function countFileMentions(prompt: string): number {
  const matches = prompt.match(FILE_RE) ?? [];
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

function tier3Reason(prompt: string, contextTokens: number): string | undefined {
  for (const rule of TIER3_RULES) {
    if (rule.re.test(prompt)) return rule.reason;
  }
  const files = countFileMentions(prompt);
  if (files > MAX_SINGLE_MODULE_FILES) return `change spans ${String(files)} files`;
  if (contextTokens >= LARGE_CONTEXT_TOKENS) {
    return `large context (${String(contextTokens)} tokens) exceeds the tier-2 budget`;
  }
  return undefined;
}

function tier2Reason(prompt: string): string {
  for (const rule of TIER2_RULES) {
    if (rule.re.test(prompt)) return rule.reason;
  }
  return 'routine single-module task';
}

/**
 * Routes a task to one of the three cascade tiers without calling an LLM.
 *
 * The classifier is deliberately conservative: a deterministic tier-1 route requires a
 * read-only/static-check shape *and* no mutation verb anywhere in the prompt. Everything that
 * looks risky or broad falls through to tier 3.
 */
export function routeTask(prompt: string, contextTokens: number): CascadeRoute {
  const text = typeof prompt === 'string' ? prompt : '';
  const tokens = Number.isFinite(contextTokens) ? Math.max(0, Math.floor(contextTokens)) : 0;

  const fast = fastPathReason(text);
  if (fast) {
    return {
      tier: 1,
      modelSuggested: TIER_MODELS[1],
      reason: `tier 1: ${fast}; no model turn required`,
    };
  }

  const complex = tier3Reason(text, tokens);
  if (complex) {
    return {
      tier: 3,
      modelSuggested: TIER_MODELS[3],
      reason: `tier 3: ${complex}; frontier reasoning required`,
    };
  }

  const targeted = tier2Reason(text);
  return {
    tier: 2,
    modelSuggested: TIER_MODELS[2],
    reason: `tier 2: ${targeted}; fast/cheap model is sufficient`,
  };
}
