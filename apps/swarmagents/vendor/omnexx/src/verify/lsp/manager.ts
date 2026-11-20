import { PersistentLspClient, type LspClientOptions } from './client.js';

export class LspClientManager {
  private clients = new Map<string, PersistentLspClient>();

  key(root: string, language: string): string {
    return `${root}:${language}`;
  }

  get(root: string, language: string, options?: Partial<LspClientOptions>): PersistentLspClient {
    const k = this.key(root, language);
    let client = this.clients.get(k);
    if (!client) {
      client = new PersistentLspClient({
        root,
        language,
        ...options,
      });
      this.clients.set(k, client);
    }
    return client;
  }

  getClient(
    root: string,
    language: string,
    options?: Partial<LspClientOptions>,
  ): PersistentLspClient {
    return this.get(root, language, options);
  }

  acquire(
    root: string,
    language: string,
    options?: Partial<LspClientOptions>,
  ): PersistentLspClient {
    return this.get(root, language, options);
  }

  has(root: string, language: string): boolean {
    return this.clients.has(this.key(root, language));
  }

  async dispose(root: string, language: string): Promise<void> {
    const k = this.key(root, language);
    const client = this.clients.get(k);
    if (client) {
      await client.close();
      this.clients.delete(k);
    }
  }

  async disposeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }

  async closeAll(): Promise<void> {
    return this.disposeAll();
  }

  async stopAll(): Promise<void> {
    return this.disposeAll();
  }

  get size(): number {
    return this.clients.size;
  }
}

export const lspClientManager = new LspClientManager();

// Alias for tests that expect a singleton accessor.
export function getLspClientManager(): LspClientManager {
  return lspClientManager;
}
