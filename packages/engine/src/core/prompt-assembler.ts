import { canonicalizePrefixText, canonicalizeTools, computePrefixHash } from '../agent/context.js';
import type { Message, SystemBlock, ToolSpec } from '../providers/types.js';

export interface Level0Core {
  /** Immutable core identity and behavioral guardrails. */
  systemPrompt: string;
  /** Canonical, static tool definitions. */
  tools: readonly ToolSpec[];
}

export interface Level1Session {
  /** AST RepoMap or codebase outline slice. */
  repoMap?: string;
  /** Verified repository environment facts (OS, compilers, package manager). */
  facts?: string;
  /** Stable workspace configuration settings. */
  settings?: string;
  /** Cross-cycle lessons and architectural notes. */
  notes?: string;
  /** Global goal & intent. */
  goal?: string;
  /** Normalized repository root. */
  repoRoot?: string;
}

export interface Level2SlidingWindow {
  /** Active task ID and title. */
  taskId: string;
  taskTitle: string;
  /** Task-specific plan context anchor. */
  planAnchor?: string;
  /** Dynamic conversational message history. */
  messages: readonly Message[];
  /** Rolling edge summary (for context compaction). */
  edgeSummary?: string;
  /** Volatile clock status (e.g. elapsed time, remaining budget). */
  clock?: string;
}

export interface AssembledPromptTopology {
  /** Ordered system blocks (strictly Level 0 Core -> Level 1 Session). */
  system: SystemBlock[];
  /** Ordered tools (sorted deterministically by name). */
  tools: ToolSpec[];
  /** Messages array with Level 2 content (plan anchor + sliding window + edge summary). */
  messages: Message[];
  /** Deterministic SHA-256 fingerprint of the frozen prefix (Level 0 + Level 1). */
  prefixHash: string;
  /** Structural summary of the topology for telemetry. */
  layers: {
    level0Bytes: number;
    level1Bytes: number;
    level2Bytes: number;
  };
}

/**
 * Three-Level Prompt Topology Assembler (CacheOptimizedAssembler)
 *
 * Enforces strict prefix stability across provider KV caches:
 * - Level 0: Immutable Core (identity, guardrails, tool schemas)
 * - Level 1: Session Semi-Static (RepoMap, verified facts, notes, goal)
 * - Level 2: Dynamic Sliding Window (current task, history, edge summary)
 */
export class CacheOptimizedAssembler {
  assemble(
    level0: Level0Core,
    level1: Level1Session,
    level2: Level2SlidingWindow,
  ): AssembledPromptTopology {
    // 1. Process Level 0 Tools (canonical alphabetical order + sorted JSON keys)
    const canonicalTools = canonicalizeTools(level0.tools, level1.repoRoot);

    // 2. Build Level 0 System Block (Immutable Core)
    const systemBlocks: SystemBlock[] = [
      {
        text: canonicalizePrefixText(level0.systemPrompt.trim(), level1.repoRoot),
        volatile: false,
      },
    ];

    // 3. Build Level 1 System Blocks (Semi-Static Session State)
    if (level1.repoMap?.trim()) {
      systemBlocks.push({
        text: canonicalizePrefixText(level1.repoMap.trim(), level1.repoRoot),
        volatile: false,
      });
    }

    if (level1.goal?.trim()) {
      systemBlocks.push({
        text: canonicalizePrefixText(`# Goal\n\n${level1.goal.trim()}`, level1.repoRoot),
        volatile: false,
      });
    }

    if (level1.settings?.trim()) {
      systemBlocks.push({
        text: canonicalizePrefixText(level1.settings.trim(), level1.repoRoot),
        volatile: false,
      });
    }

    if (level1.facts?.trim()) {
      systemBlocks.push({
        text: canonicalizePrefixText(level1.facts.trim(), level1.repoRoot),
        volatile: false,
      });
    }

    if (level1.notes?.trim()) {
      systemBlocks.push({
        text: canonicalizePrefixText(
          `# Lessons (notes.md)\n\n${level1.notes.trim()}`,
          level1.repoRoot,
        ),
        volatile: false,
      });
    }

    // Place cache breakpoint on the very last block of Level 1
    if (systemBlocks.length > 0) {
      const last = systemBlocks[systemBlocks.length - 1];
      if (last) last.cacheBreakpoint = true;
    }

    // 4. Build Level 2 Dynamic Messages
    const dynamicMessages: Message[] = [];

    // Initial cycle anchor (task & plan)
    const anchorParts: string[] = [];
    if (level2.planAnchor?.trim()) {
      anchorParts.push(level2.planAnchor.trim());
    }
    anchorParts.push(
      `# Your task now\n\nWork on ${level2.taskId}: ${level2.taskTitle}. Stop calling tools and summarize when it is done or you are blocked.`,
    );

    // Move volatile clock metadata to the dynamic user edge, never the system prefix
    if (level2.clock?.trim()) {
      anchorParts.push(level2.clock.trim());
    }

    // Append edge summary if provided
    if (level2.edgeSummary?.trim()) {
      anchorParts.push(`<history_summary>\n${level2.edgeSummary.trim()}\n</history_summary>`);
    }

    const firstUserContent = canonicalizePrefixText(anchorParts.join('\n\n'), level1.repoRoot);
    dynamicMessages.push({
      role: 'user',
      content: [{ type: 'text', text: firstUserContent }],
    });

    // Append existing conversation messages
    for (const msg of level2.messages) {
      dynamicMessages.push(msg);
    }

    // 5. Compute deterministic prefix hash. This is the FROZEN prefix fingerprint, so it covers
    // only Level 0 tools + non-volatile Level 1 system blocks. The Level 2 anchor carries dynamic
    // content (clock, task, edge summary); including it would make the digest move every turn and
    // defeat the provider KV-cache the fingerprint exists to verify.
    const prefixHash = computePrefixHash(canonicalTools, systemBlocks, '');

    const level0Text = systemBlocks[0]?.text ?? '';
    const level0Bytes =
      canonicalTools.reduce((acc, t) => acc + JSON.stringify(t).length, 0) + level0Text.length;
    const level1Bytes = systemBlocks.slice(1).reduce((acc, b) => acc + b.text.length, 0);
    const level2Bytes = dynamicMessages.reduce((acc, m) => acc + JSON.stringify(m).length, 0);

    return {
      system: systemBlocks,
      tools: canonicalTools,
      messages: dynamicMessages,
      prefixHash,
      layers: {
        level0Bytes,
        level1Bytes,
        level2Bytes,
      },
    };
  }
}
