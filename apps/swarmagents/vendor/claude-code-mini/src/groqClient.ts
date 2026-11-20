import { GroqKeyPool } from "./keypool.js";
import { ContextGovernor, ContextMessage } from "./contextGovernor.js";

export interface GroqCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: any[];
  response_format?: { type: "json_object" | "text" };
}

export class GroqClient {
  private pool: GroqKeyPool;
  public defaultModel: string = "qwen/qwen3.8-27b";
  public fastModel: string = "openai/gpt-oss-20b";
  public qwenModel: string = "qwen/qwen3.8-27b";
  public gpt120bModel: string = "openai/gpt-oss-120b";

  constructor(pool?: GroqKeyPool) {
    this.pool = pool || new GroqKeyPool();
  }

  public getPool(): GroqKeyPool {
    return this.pool;
  }

  public async chatCompletion(
    messages: ContextMessage[],
    options: GroqCompletionOptions = {}
  ): Promise<{ content: string; tool_calls?: any[]; usage?: any }> {
    const totalEstTokens = ContextGovernor.estimateMessages(messages);
    if (totalEstTokens > ContextGovernor.MAX_INPUT_TOKENS) {
      throw new Error(
        `[ContextGovernor VIOLATION] Estimated ${totalEstTokens} tokens exceeds 8k safety limit (${ContextGovernor.MAX_INPUT_TOKENS}).`
      );
    }

    const model = options.model || this.defaultModel;
    let attempts = 0;
    const maxAttempts = Math.min(this.pool.getKeyCount(), 5);

    while (attempts < maxAttempts) {
      attempts++;
      const apiKey = this.pool.getNextKey();

      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: options.temperature ?? 0.1,
            max_tokens: options.max_tokens ?? ContextGovernor.OUTPUT_BUFFER_TOKENS,
            tools: options.tools,
            response_format: options.response_format,
          }),
        });

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after")) || 10;
          this.pool.reportRateLimit(apiKey, retryAfter);
          continue; // rotate to next key
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Groq API error HTTP ${response.status}: ${errText}`);
        }

        const data: any = await response.json();
        const choice = data.choices?.[0];
        const usage = data.usage;

        this.pool.reportSuccess(apiKey, usage?.total_tokens || 0);

        return {
          content: choice?.message?.content || "",
          tool_calls: choice?.message?.tool_calls,
          usage,
        };
      } catch (err: any) {
        if (attempts >= maxAttempts) throw err;
      }
    }

    throw new Error("Exhausted retries across available Groq keys.");
  }
}
