import { readFileSync } from 'node:fs';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class GroqPool {
  private keys: string[] = [];
  private currentKeyIndex = 0;
  private readonly model: string;

  constructor(model = 'qwen/qwen3.8-27b') {
    this.model = model;
    this.loadKeys();
  }

  private loadKeys(): void {
    try {
      const content = readFileSync('/Users/dev/swarmagents/api_keys.md', 'utf-8');
      const matches = content.match(/gsk_[A-Za-z0-9]+/g);
      if (matches && matches.length > 0) {
        this.keys = Array.from(new Set(matches));
      }
    } catch (e) {
      console.warn('Could not read api_keys.md, checking process.env:', e);
      if (process.env.GROQ_API_KEY) {
        this.keys = [process.env.GROQ_API_KEY];
      }
    }
    if (this.keys.length === 0) {
      throw new Error('No Groq API keys found in /Users/dev/swarmagents/api_keys.md');
    }
  }

  public getKeyCount(): number {
    return this.keys.length;
  }

  public getNextKey(): string {
    const key = this.keys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
    return key;
  }

  public async chatCompletion(messages: ChatMessage[], temperature = 0.2): Promise<string> {
    let attempts = 0;
    let lastError: any = null;

    while (attempts < this.keys.length) {
      const apiKey = this.getNextKey();
      attempts++;
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': 'AGL-Swarm/1.0'
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: 4096
          })
        });

        if (!response.ok) {
          const errBody = await response.text();
          if (response.status === 429) {
            // Rate limit, rotate to next key
            console.warn(`[GroqPool] Key ${apiKey.slice(0, 10)}... rate limited (429). Rotating.`);
            continue;
          }
          throw new Error(`Groq API HTTP ${response.status}: ${errBody}`);
        }

        const data: any = await response.json();
        return data.choices?.[0]?.message?.content || '';
      } catch (err: any) {
        lastError = err;
      }
    }

    throw new Error(`GroqPool exhausted all ${this.keys.length} keys: ${lastError?.message || lastError}`);
  }
}
