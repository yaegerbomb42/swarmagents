import * as fs from "fs";
import * as path from "path";

export interface KeyStatus {
  key: string;
  cooldownUntil: number;
  failureCount: number;
  totalCalls: number;
  totalTokens: number;
}

export class GroqKeyPool {
  private keys: KeyStatus[] = [];
  private currentIndex: number = 0;

  constructor(customKeys?: string[]) {
    if (customKeys && customKeys.length > 0) {
      this.initKeys(customKeys);
    } else {
      this.loadKeysFromMonolith();
    }
  }

  private initKeys(rawKeys: string[]) {
    this.keys = rawKeys.map((key) => ({
      key: key.trim(),
      cooldownUntil: 0,
      failureCount: 0,
      totalCalls: 0,
      totalTokens: 0,
    }));
  }

  private loadKeysFromMonolith() {
    const candidatePaths = [
      path.resolve(process.cwd(), "api_keys.md"),
      path.resolve(process.cwd(), "../../api_keys.md"),
      "/Users/dev/swarmagents/api_keys.md",
      path.join(process.env.HOME || "", ".config/omnexx/credentials/groq.key"),
    ];

    const foundKeys: Set<string> = new Set();

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const matches = content.match(/gsk_[a-zA-Z0-9_-]{20,}/g);
          if (matches) {
            for (const m of matches) foundKeys.add(m);
          }
        } catch {}
      }
    }

    if (foundKeys.size === 0) {
      throw new Error("No Groq keys found! Check api_keys.md or provide customKeys.");
    }

    this.initKeys(Array.from(foundKeys));
  }

  public getKeyCount(): number {
    return this.keys.length;
  }

  public getNextKey(): string {
    const now = Date.now();
    const available = this.keys.filter((k) => k.cooldownUntil <= now);

    if (available.length === 0) {
      const minWait = Math.min(...this.keys.map((k) => k.cooldownUntil)) - now;
      throw new Error(`All ${this.keys.length} Groq keys on rate-limit cooldown. Wait ${Math.ceil(minWait / 1000)}s.`);
    }

    const keyObj = available[this.currentIndex % available.length];
    this.currentIndex = (this.currentIndex + 1) % available.length;
    keyObj.totalCalls++;
    return keyObj.key;
  }

  public reportRateLimit(key: string, retryAfterSeconds: number = 10) {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) {
      entry.failureCount++;
      const backoffSec = Math.max(retryAfterSeconds, Math.pow(2, Math.min(entry.failureCount, 5)));
      entry.cooldownUntil = Date.now() + backoffSec * 1000;
      console.warn(`[KeyPool] Key ${key.substring(0, 10)}... rate limited. Backoff ${backoffSec}s.`);
    }
  }

  public reportSuccess(key: string, tokensUsed: number = 0) {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) {
      entry.failureCount = 0;
      entry.totalTokens += tokensUsed;
    }
  }

  public getStats() {
    return this.keys.map((k) => ({
      keyPrefix: k.key.substring(0, 10) + "...",
      isCooling: k.cooldownUntil > Date.now(),
      cooldownRemainingSec: Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000)),
      totalCalls: k.totalCalls,
      totalTokens: k.totalTokens,
    }));
  }
}
