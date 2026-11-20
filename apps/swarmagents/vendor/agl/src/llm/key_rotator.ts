import { readFileSync } from 'node:fs';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface KeyState {
  key: string;
  inFlight: number;
  lastUsed: number;
  cooldownUntil: number;
}

export class KeyRotator {
  private keyStates: KeyState[] = [];
  private readonly model: string;
  private readonly maxConcurrencyPerKey: number;

  constructor(model = 'qwen/qwen3.8-27b', maxConcurrencyPerKey = 2) {
    this.model = model;
    this.maxConcurrencyPerKey = maxConcurrencyPerKey;
    this.loadKeys();
  }

  private loadKeys(): void {
    const content = readFileSync('/Users/dev/swarmagents/api_keys.md', 'utf-8');
    const matches = Array.from(new Set(content.match(/gsk_[A-Za-z0-9]+/g) || []));
    if (matches.length === 0) {
      throw new Error('No Groq API keys found in api_keys.md');
    }
    this.keyStates = matches.map(k => ({
      key: k,
      inFlight: 0,
      lastUsed: 0,
      cooldownUntil: 0
    }));
    console.log(`[KeyRotator] Initialized with ${this.keyStates.length} Groq API keys.`);
  }

  public getKeyCount(): number {
    return this.keyStates.length;
  }

  private async acquireKey(): Promise<KeyState> {
    while (true) {
      const now = Date.now();
      // Find candidate key not on cooldown and below concurrency limit
      const candidates = this.keyStates.filter(
        s => s.cooldownUntil <= now && s.inFlight < this.maxConcurrencyPerKey
      );

      if (candidates.length > 0) {
        // Pick the least recently used candidate
        candidates.sort((a, b) => a.lastUsed - b.lastUsed);
        const chosen = candidates[0];
        chosen.inFlight++;
        chosen.lastUsed = now;
        return chosen;
      }

      // If all keys are saturated or cooling down, wait briefly
      await new Promise(res => setTimeout(res, 50));
    }
  }

  public async chat(messages: ChatMessage[], temperature = 0.1, maxTokens = 2048): Promise<string> {
    let retries = 0;
    const maxRetries = this.keyStates.length * 3;

    while (retries < maxRetries) {
      const keyState = await this.acquireKey();
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${keyState.key}`,
            'User-Agent': 'AGL-Agent-Swarm/1.0'
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: maxTokens
          })
        });

        if (response.status === 429) {
          // Rate limit triggered: put this key on cooldown for 1.5s
          keyState.cooldownUntil = Date.now() + 1500;
          retries++;
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data: any = await response.json();
        return data.choices?.[0]?.message?.content || '';
      } catch (err: any) {
        retries++;
        // short delay on network error
        await new Promise(r => setTimeout(r, 100));
      } finally {
        keyState.inFlight--;
      }
    }

    throw new Error('KeyRotator exhausted retries across all keys.');
  }
}
