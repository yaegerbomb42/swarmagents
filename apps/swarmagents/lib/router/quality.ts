import type { ToolCallPayload } from "./types";

export interface QualityCheckInput {
  outputText?: string;
  toolCalls?: ToolCallPayload[];
  requiresTools: boolean;
  promptSample?: string;
}

export interface QualityCheckResult {
  isGarbled: boolean;
  reason?: "empty_output" | "invalid_tool_json" | "repetition_loop" | "charset_corruption";
  details?: string;
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function hasInvalidToolCalls(toolCalls?: ToolCallPayload[]): string | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    if (!tc.name || typeof tc.name !== "string") {
      return `Tool call #${i} missing valid function name`;
    }
    if (typeof tc.arguments === "string") {
      try {
        const parsed: unknown = JSON.parse(tc.arguments);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return `Tool call "${tc.name}" arguments JSON did not decode to an object`;
        }
      } catch {
        return `Tool call "${tc.name}" contains malformed JSON arguments`;
      }
    } else if (typeof tc.arguments !== "object" || tc.arguments === null || Array.isArray(tc.arguments)) {
      return `Tool call "${tc.name}" arguments is not a valid object`;
    }
  }
  return null;
}

function detectRepetitionLoop(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 120) return null;

  // 1. Exact line repetition check
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);

  if (lines.length >= 6) {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const next = (counts.get(line) ?? 0) + 1;
      counts.set(line, next);
      if (next >= 5 && next / lines.length > 0.4) {
        return `Line repeated ${next}/${lines.length} times`;
      }
    }
  }

  // 2. Sliding 24-char chunk repetition check
  const chunkSize = 24;
  const step = 8;
  const chunkCounts = new Map<string, number>();
  for (let i = 0; i + chunkSize <= trimmed.length; i += step) {
    const chunk = trimmed.slice(i, i + chunkSize);
    if (chunk.trim().length < 16) continue;
    const count = (chunkCounts.get(chunk) ?? 0) + 1;
    chunkCounts.set(chunk, count);
    if (count >= 4 && (count * chunkSize) / trimmed.length > 0.45) {
      return `24-char pattern repeated ${count} times across output`;
    }
  }

  return null;
}

function detectCharsetOrLanguageCorruption(text: string, promptSample?: string): string | null {
  if (!text) return null;

  // 1. Unicode replacement characters (\uFFFD) or illegal control characters
  let replacementCount = 0;
  let controlCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) {
      replacementCount++;
    } else if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      controlCount++;
    }
  }

  if (replacementCount >= 2 || replacementCount / text.length > 0.005) {
    return `Detected ${replacementCount} Unicode replacement characters (\\uFFFD)`;
  }
  if (controlCount / text.length > 0.01) {
    return `Detected excessive control characters (${controlCount})`;
  }

  // 2. Unexpected non-Latin script bleed on ASCII/Latin prompts (outside code fences)
  const prose = stripFencedCodeBlocks(text).trim();
  if (prose.length >= 40) {
    const nonLatinLetters = prose.match(
      /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    );
    const allLetters = prose.match(/\p{Letter}/gu);
    if (allLetters && allLetters.length >= 20 && nonLatinLetters) {
      const nonLatinRatio = nonLatinLetters.length / allLetters.length;
      if (nonLatinRatio > 0.35) {
        // Verify prompt itself wasn't using those scripts
        const promptNonLatin = promptSample?.match(
          /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        );
        if (!promptNonLatin || promptNonLatin.length < 3) {
          return `Unexpected non-Latin script ratio ${(nonLatinRatio * 100).toFixed(1)}% in prose`;
        }
      }
    }
  }

  return null;
}

export function inspectOutputQuality(input: QualityCheckInput): QualityCheckResult {
  const text = input.outputText ?? "";
  const hasText = text.trim().length > 0;
  const hasTools = Boolean(input.toolCalls && input.toolCalls.length > 0);

  if (!hasText && !hasTools) {
    return {
      isGarbled: true,
      reason: "empty_output",
      details: "200 OK response contained neither text content nor tool calls",
    };
  }

  const toolError = hasInvalidToolCalls(input.toolCalls);
  if (toolError) {
    return {
      isGarbled: true,
      reason: "invalid_tool_json",
      details: toolError,
    };
  }

  if (hasText) {
    const charsetError = detectCharsetOrLanguageCorruption(text, input.promptSample);
    if (charsetError) {
      return {
        isGarbled: true,
        reason: "charset_corruption",
        details: charsetError,
      };
    }

    const repetitionError = detectRepetitionLoop(text);
    if (repetitionError) {
      return {
        isGarbled: true,
        reason: "repetition_loop",
        details: repetitionError,
      };
    }
  }

  return { isGarbled: false };
}
