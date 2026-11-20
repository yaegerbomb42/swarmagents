import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface ProviderLink {
  name: string;
  keyPrefix: string;
  consoleUrl: string;
  defaultModel: string;
  baseUrl: string;
}

export const SUPPORTED_PROVIDERS: Record<string, ProviderLink> = {
  groq: {
    name: "Groq (Lightning Fast - Free Tier)",
    keyPrefix: "gsk_",
    consoleUrl: "https://console.groq.com/keys",
    defaultModel: "qwen/qwen3.8-27b",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  mistral: {
    name: "Mistral / Codestral (Code Specialist)",
    keyPrefix: "",
    consoleUrl: "https://console.mistral.ai/api-keys/",
    defaultModel: "codestral-latest",
    baseUrl: "https://codestral.mistral.ai/v1",
  },
  nvidia: {
    name: "NVIDIA NIM (Free Trial Credits - Nemotron 550B)",
    keyPrefix: "nvapi-",
    consoleUrl: "https://build.nvidia.com/explore/discover",
    defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  openrouter: {
    name: "OpenRouter (Universal Router / Any Model)",
    keyPrefix: "sk-or-",
    consoleUrl: "https://openrouter.ai/keys",
    defaultModel: "anthropic/claude-3.5-haiku",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

export class QuickConnectTool {
  private configDir: string;
  private configFile: string;

  constructor() {
    this.configDir = path.join(process.env.HOME || "", ".config/claude-code-mini");
    this.configFile = path.join(this.configDir, "providers.json");
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Opens the API key generation console in the user's default browser automatically
   */
  public static openInBrowser(url: string) {
    try {
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execSync(`${openCmd} "${url}"`, { stdio: "ignore" });
    } catch {}
  }

  public saveKey(providerId: string, apiKey: string) {
    let existing: Record<string, string[]> = {};
    if (fs.existsSync(this.configFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(this.configFile, "utf-8"));
      } catch {}
    }

    if (!existing[providerId]) existing[providerId] = [];
    if (!existing[providerId].includes(apiKey.trim())) {
      existing[providerId].push(apiKey.trim());
    }

    fs.writeFileSync(this.configFile, JSON.stringify(existing, null, 2), "utf-8");
  }

  public getSavedKeys(): Record<string, string[]> {
    if (fs.existsSync(this.configFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.configFile, "utf-8"));
      } catch {}
    }
    return {};
  }
}
