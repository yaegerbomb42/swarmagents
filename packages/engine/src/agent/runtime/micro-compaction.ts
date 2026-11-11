import type { Message } from '../../providers/types.js';

export interface MicroCompactOptions {
  /**
   * Number of trailing messages protected from mutation (hot recent turns).
   * Default: 6.
   */
  hotWindowSize?: number;

  /**
   * Maximum character ceiling for cold tool results before middle truncation.
   * Default: 2,000 chars.
   */
  maxColdChars?: number;

  /**
   * Compaction stride: only compact when turnIndex % stride === 0.
   * Default: 4.
   */
  stride?: number;

  /**
   * Active turn index.
   */
  turnIndex: number;
}

export interface MicroCompactResult {
  compacted: boolean;
  messages: Message[];
  charsSaved: number;
  rulesApplied: {
    supersededReads: number;
    collapsedErrors: number;
    truncatedColdOutputs: number;
  };
}

/**
 * Micro-Amortized History Compaction (Step 3.5)
 *
 * Runs on a periodic stride (every N turns) strictly outside the pinned prefix (Slot 0-6)
 * and the hot recent interaction window, pruning dead tokens before they inflate context.
 */
export function microCompact(
  messages: readonly Message[],
  options: MicroCompactOptions,
): MicroCompactResult {
  const stride = options.stride ?? 4;
  if (stride > 1 && options.turnIndex % stride !== 0) {
    return {
      compacted: false,
      messages: [...messages],
      charsSaved: 0,
      rulesApplied: { supersededReads: 0, collapsedErrors: 0, truncatedColdOutputs: 0 },
    };
  }

  const hotWindowSize = Math.max(2, options.hotWindowSize ?? 6);
  const maxColdChars = Math.max(500, options.maxColdChars ?? 2_000);

  // If messages don't exceed the frozen anchor (1) + hot window, skip
  if (messages.length <= 1 + hotWindowSize) {
    return {
      compacted: false,
      messages: [...messages],
      charsSaved: 0,
      rulesApplied: { supersededReads: 0, collapsedErrors: 0, truncatedColdOutputs: 0 },
    };
  }

  const coldEndIndex = messages.length - hotWindowSize;

  // Track all tool uses across the entire conversation by toolUseId and by signature
  const toolUseById = new Map<string, { name: string; sig: string; msgIdx: number }>();
  const toolCallSignatures = new Map<string, number[]>(); // signature -> message indices

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const sig = `${block.name}:${JSON.stringify(block.input ?? {})}`;
        toolUseById.set(block.id, { name: block.name, sig, msgIdx: mIdx });
        const existing = toolCallSignatures.get(sig) ?? [];
        existing.push(mIdx);
        toolCallSignatures.set(sig, existing);
      }
    }
  }

  let totalCharsSaved = 0;
  let supersededReads = 0;
  let collapsedErrors = 0;
  let truncatedColdOutputs = 0;

  // Deep clone candidate cold messages
  const nextMessages: Message[] = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => ({ ...b })),
  }));

  // Iterate strictly through the cold zone [1 .. coldEndIndex - 1]
  for (let mIdx = 1; mIdx < coldEndIndex; mIdx++) {
    const msg = nextMessages[mIdx];
    if (!msg) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;

      const initialLength = block.content.length;
      const useInfo = toolUseById.get(block.toolUseId);

      // Rule A: Check if THIS specific tool call was superseded by an identical read/search later
      if (
        useInfo &&
        (useInfo.name === 'read_file' || useInfo.name === 'read' || useInfo.name === 'search')
      ) {
        const sameCallIndices = toolCallSignatures.get(useInfo.sig) ?? [];
        const hasLaterInstance = sameCallIndices.some((idx) => idx > useInfo.msgIdx);
        if (hasLaterInstance && block.content.length > 200) {
          block.content = '[μc] superseded: identical read/search call repeated in later turn';
          supersededReads++;
          totalCharsSaved += initialLength - block.content.length;
          continue;
        }
      }

      // Rule B: Collapse verbose error traces in the cold zone to their first
      // line. The collapse applies to every cold error longer than 300 chars —
      // there is no subsequent-success check; the hot window keeps recent
      // errors intact, and the detail is gone from the cold zone either way.
      if (block.isError && block.content.length > 300) {
        const lines = block.content.split('\n').filter((l) => l.trim().length > 0);
        const firstLine = lines[0] ?? 'Command failed';
        block.content = `[μc] resolved error: ${firstLine.slice(0, 160)}`;
        collapsedErrors++;
        totalCharsSaved += initialLength - block.content.length;
        continue;
      }

      // Rule C: Truncate cold outputs exceeding maxColdChars
      if (block.content.length > maxColdChars) {
        if (block.content.length <= 1_400) {
          // Too short for a head/tail split: a fixed 1,000 + 400 split would
          // inflate the output and report a negative "omitted" count whenever
          // maxColdChars < 1,400. Truncate to the ceiling instead.
          const omitted = block.content.length - maxColdChars;
          block.content = `${block.content.slice(0, maxColdChars)}\n[... truncated by micro-compaction: ${String(omitted)} cold characters omitted ...]`;
        } else {
          const head = block.content.slice(0, 1_000);
          const tail = block.content.slice(-400);
          const omitted = block.content.length - 1_400;
          block.content = `${head}\n[... truncated by micro-compaction: ${String(omitted)} cold characters omitted ...]\n${tail}`;
        }
        truncatedColdOutputs++;
        totalCharsSaved += initialLength - block.content.length;
      }
    }
  }

  const compacted = totalCharsSaved > 0;
  return {
    compacted,
    messages: nextMessages,
    charsSaved: totalCharsSaved,
    rulesApplied: {
      supersededReads,
      collapsedErrors,
      truncatedColdOutputs,
    },
  };
}
