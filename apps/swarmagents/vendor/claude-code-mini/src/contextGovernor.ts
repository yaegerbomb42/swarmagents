export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export class ContextGovernor {
  public static readonly MAX_TOTAL_TOKENS = 8192;
  public static readonly MAX_INPUT_TOKENS = 7200;
  public static readonly OUTPUT_BUFFER_TOKENS = 992;

  /**
   * Fast token estimation calibrated for Llama 3 / Code tokenization (~3.7 chars per token)
   */
  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 3.7);
  }

  public static estimateMessages(messages: ContextMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg.content) + 4; // overhead per message
    }
    return total;
  }

  /**
   * Builds the strict, micro-system prompt (<300 tokens)
   */
  public static getMicroSystemPrompt(currentTask: string, contractInvariants?: string): string {
    return [
      "YOU ARE CLAUDE-CODE-MINI: A stateless, hyper-efficient code execution engine.",
      "GOVERNOR RULES:",
      "1. You operate under a strict 8k token limit. Never output conversational pleasantries, apologies, or explanations.",
      "2. State is externalized. You have zero conversation memory. Rely purely on the supplied task, error, and code slice.",
      "3. Code edits must be deterministic unified diffs or atomic function replacements.",
      `CURRENT TASK: ${currentTask}`,
      contractInvariants ? `CONTRACT INVARIANTS: ${contractInvariants}` : "",
      "Respond strictly with tool calls or compact patches.",
    ].filter(Boolean).join("\n");
  }

  /**
   * Enforces that payload fits strictly within the 8k window.
   * If payload exceeds max budget, slices or truncates safely.
   */
  public static fitWithinBudget(
    systemPrompt: string,
    stateMemory: string,
    payloadCodeOrError: string,
    maxPayloadTokens: number = 5500
  ): { safePayload: string; estimatedTokens: number } {
    const sysTokens = this.estimateTokens(systemPrompt);
    const stateTokens = this.estimateTokens(stateMemory);
    const remainingBudget = Math.max(500, ContextGovernor.MAX_INPUT_TOKENS - sysTokens - stateTokens);

    const payloadTokens = this.estimateTokens(payloadCodeOrError);
    if (payloadTokens <= remainingBudget) {
      return {
        safePayload: payloadCodeOrError,
        estimatedTokens: sysTokens + stateTokens + payloadTokens,
      };
    }

    // Surgical slice: Keep first 20% and last 80% if it's an error stack trace,
    // or clamp lines if it's code.
    const maxChars = Math.floor(remainingBudget * 3.7);
    const half = Math.floor(maxChars / 2);
    const truncated =
      payloadCodeOrError.slice(0, half) +
      "\n\n[...SNIPPED FOR 8K BUDGET...]\n\n" +
      payloadCodeOrError.slice(-half);

    return {
      safePayload: truncated,
      estimatedTokens: sysTokens + stateTokens + this.estimateTokens(truncated),
    };
  }
}
