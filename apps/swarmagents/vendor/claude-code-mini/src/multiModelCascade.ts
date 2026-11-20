import { GroqClient } from "./groqClient.js";
import { MultiProviderKeyPool } from "./multiProviderKeyPool.js";
import { ContextGovernor, ContextMessage } from "./contextGovernor.js";
import * as fs from "fs";
import * as path from "path";

export interface CascadeProvider {
  name: string;
  client: any;
}

export class MultiModelCascade {
  private groqClient: GroqClient;
  private fallbackPools: MultiProviderKeyPool[] = [];

  constructor(groqClient?: GroqClient) {
    this.groqClient = groqClient || new GroqClient();
    this.loadFallbackProviders();
  }

  private loadFallbackProviders() {
    const configPath = path.join(process.env.HOME || "", ".config/claude-code-mini/providers.json");
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (data.mistral && data.mistral.length > 0) {
          this.fallbackPools.push(
            new MultiProviderKeyPool({
              providerName: "Mistral Codestral",
              baseUrl: "https://codestral.mistral.ai/v1",
              model: "codestral-latest",
              keys: data.mistral,
            })
          );
        }
        if (data.nvidia && data.nvidia.length > 0) {
          this.fallbackPools.push(
            new MultiProviderKeyPool({
              providerName: "NVIDIA NIM",
              baseUrl: "https://integrate.api.nvidia.com/v1",
              model: "nvidia/nemotron-3-ultra-550b-a55b",
              keys: data.nvidia,
            })
          );
        }
      } catch {}
    }
  }

  /**
   * Tries primary Groq client first. If rate limited (429) or down,
   * cascades seamlessly to Mistral Codestral or NVIDIA NIM.
   */
  public async chatCompletionWithCascade(
    messages: ContextMessage[],
    options: any = {}
  ): Promise<{ content: string; providerUsed: string; usage?: any }> {
    try {
      const res = await this.groqClient.chatCompletion(messages, options);
      return { content: res.content, providerUsed: "Groq (Qwen-3.8-27b)", usage: res.usage };
    } catch (groqErr: any) {
      console.warn(`[MultiModelCascade] Groq unavailable (${groqErr.message}). Cascading to backup provider...`);

      for (const backup of this.fallbackPools) {
        try {
          const res = await backup.chatCompletion(messages, options);
          return { content: res.content, providerUsed: (backup as any).config.providerName, usage: res.usage };
        } catch (backupErr: any) {
          console.warn(`[MultiModelCascade] Backup provider failed: ${backupErr.message}`);
        }
      }

      throw groqErr;
    }
  }
}
