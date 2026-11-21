import fs from "node:fs/promises";
import path from "node:path";
import type { DecisionLogEntry } from "./types";

export class DecisionLogger {
  private readonly entries: DecisionLogEntry[] = [];
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
  }

  async log(entry: DecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.filePath) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    }
  }

  getEntries(): readonly DecisionLogEntry[] {
    return this.entries;
  }

  getSummary(): {
    totalDecisions: number;
    escalatedCount: number;
    escalationRate: number;
    avgLatencyMs: number;
  } {
    const total = this.entries.length;
    if (total === 0) {
      return { totalDecisions: 0, escalatedCount: 0, escalationRate: 0, avgLatencyMs: 0 };
    }
    const escalatedCount = this.entries.filter((e) => e.escalated).length;
    const avgLatencyMs = this.entries.reduce((sum, e) => sum + e.latencyMs, 0) / total;
    return {
      totalDecisions: total,
      escalatedCount,
      escalationRate: escalatedCount / total,
      avgLatencyMs,
    };
  }
}
