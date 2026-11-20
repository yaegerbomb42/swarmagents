import * as fs from "fs";
import * as path from "path";
import { ContextGovernor, ContextMessage } from "./contextGovernor.js";

export interface ProviderKeyConfig {
  providerName: string;
  baseUrl: string;
  model: string;
  keys: string[];
}

export class MultiProviderKeyPool {
  private config: ProviderKeyConfig;
  private keyIndex: number = 0;
  private keyCooldowns: Map<string, number> = new Map();

  constructor(config: ProviderKeyConfig) {
    this.config = config;
    for (const k of config.keys) {
      this.keyCooldowns.set(k, 0);
    }
  }

  public getNextKey(): string {
    const now = Date.now();
    const available = this.config.keys.filter((k) => (this.keyCooldowns.get(k) || 0) <= now);

    if (available.length === 0) {
      const minWait = Math.min(...Array.from(this.keyCooldowns.values())) - now;
      throw new Error(`All ${this.config.keys.length} keys for ${this.config.providerName} on cooldown. Wait ${Math.ceil(minWait / 1000)}s.`);
    }

    const key = available[this.keyIndex % available.length];
    this.keyIndex = (this.keyIndex + 1) % available.length;
    return key;
  }

  public reportRateLimit(key: string, retryAfterSeconds: number = 5) {
    this.keyCooldowns.set(key, Date.now() + retryAfterSeconds * 1000);
    console.warn(`[${this.config.providerName}] Key ${key.substring(0, 10)}... cooldown ${retryAfterSeconds}s.`);
  }

  public async chatCompletion(
    messages: ContextMessage[],
    options: { max_tokens?: number; temperature?: number; response_format?: any } = {}
  ): Promise<{ content: string; usage?: any; durationMs: number }> {
    let attempts = 0;
    const maxAttempts = Math.min(this.config.keys.length, 5);

    while (attempts < maxAttempts) {
      attempts++;
      const apiKey = this.getNextKey();
      const t0 = Date.now();

      try {
        const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: options.temperature ?? 0.1,
            max_tokens: options.max_tokens ?? 1024,
            response_format: options.response_format,
          }),
        });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after")) || 5;
          this.reportRateLimit(apiKey, retryAfter);
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`[${this.config.providerName}] HTTP ${res.status}: ${errText}`);
        }

        const data: any = await res.json();
        const durationMs = Date.now() - t0;
        const content = data.choices?.[0]?.message?.content || "";
        const usage = data.usage;

        return { content, usage, durationMs };
      } catch (err: any) {
        if (attempts >= maxAttempts) throw err;
      }
    }

    throw new Error(`Exhausted retries for ${this.config.providerName}`);
  }
}
