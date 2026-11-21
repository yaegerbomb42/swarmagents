import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CapabilityEntrySchema,
  RegistryCacheSchema,
  type CapabilityEntry,
  type RegistryCache,
} from "../schema";

// Standalone default. SwarmAgents callers must pass an explicit per-user /
// per-workspace path instead — never share one registry across users.
export function defaultCachePath(): string {
  return path.join(os.homedir(), ".capability-atlas", "registry.json");
}

export class RegistryStore {
  readonly filePath: string;

  constructor(filePath: string = defaultCachePath()) {
    this.filePath = filePath;
  }

  async load(): Promise<RegistryCache | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return RegistryCacheSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  async save(entries: CapabilityEntry[]): Promise<RegistryCache> {
    const validated = entries.map((e) => CapabilityEntrySchema.parse(e));
    const cache: RegistryCache = {
      version: 1,
      lastRefreshedAt: new Date().toISOString(),
      entries: validated,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
    return cache;
  }

  async upsert(partial: CapabilityEntry[]): Promise<RegistryCache> {
    const existing = (await this.load())?.entries ?? [];
    const map = new Map(existing.map((e) => [e.id, e]));
    for (const entry of partial) {
      map.set(entry.id, CapabilityEntrySchema.parse(entry));
    }
    return this.save(Array.from(map.values()));
  }
}
