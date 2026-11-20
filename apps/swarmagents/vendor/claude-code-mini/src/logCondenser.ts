import { GroqClient } from "./groqClient.js";
import { ContextGovernor } from "./contextGovernor.js";

export class LogCondenser {
  private client: GroqClient;

  constructor(client?: GroqClient) {
    this.client = client || new GroqClient();
  }

  /**
   * Pre-filters common noise before prompting LLM to avoid truncation bias
   */
  public preFilterNoise(raw: string): string {
    const lines = raw.split("\n");
    const priorityFailures: string[] = [];
    const internalNoise = [/node:internal/i, /node_modules/i, /at async Promise/i];
    const failureClues = [/fail/i, /error/i, /expected/i, /received/i, /assert/i, /syntax/i, /uncaught/i, /critical failure/i];

    for (const line of lines) {
      // Discard internal runtime boilerplate frames
      if (internalNoise.some((regex) => regex.test(line))) {
        continue;
      }
      if (failureClues.some((regex) => regex.test(line))) {
        priorityFailures.push(line);
      }
    }

    if (priorityFailures.length > 0) {
      return priorityFailures.slice(0, 40).join("\n");
    }

    // Fallback: take tail of log where errors usually live
    return lines.slice(-40).join("\n");
  }

  /**
   * Condenses a long compiler or test output into a strict ~200-300 token error extract.
   * If the raw text is already small (<1,500 chars), returns it directly.
   */
  public async condenseLog(rawLog: string): Promise<string> {
    const estimatedTokens = ContextGovernor.estimateTokens(rawLog);
    if (estimatedTokens < 350) {
      return rawLog.trim();
    }

    const preFiltered = this.preFilterNoise(rawLog);

    // Micro prompt to extract root failure without any conversational fluff
    const prompt = [
      "TASK: Extract ONLY the critical failures, syntax errors, failed test assertions, and exact file:line paths from this build/test log.",
      "RULES:",
      "1. Strip all passing tests, standard notices, and internal framework stack frames.",
      "2. Return at most 10-15 lines.",
      "3. Zero introductory or concluding prose.",
      "",
      "FILTERED LOG:",
      preFiltered,
    ].join("\n");

    try {
      const response = await this.client.chatCompletion(
        [
          { role: "system", content: "You are a compiler error extraction filter. Output raw filtered errors only." },
          { role: "user", content: prompt },
        ],
        {
          model: this.client.fastModel,
          temperature: 0.0,
          max_tokens: 350,
        }
      );

      return response.content.trim() || rawLog.slice(0, 1000);
    } catch (err: any) {
      console.warn(`[LogCondenser] Fast compression failed, using heuristic truncation: ${err.message}`);
      // Fallback: take head and tail
      const lines = rawLog.split("\n");
      if (lines.length > 25) {
        return [...lines.slice(0, 10), "\n...[SNIPPED]...\n", ...lines.slice(-15)].join("\n");
      }
      return rawLog;
    }
  }
}
