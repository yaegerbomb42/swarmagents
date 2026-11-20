import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface Snapshot {
  filePath: string;
  originalContent: string;
  timestamp: number;
}

export class SafetySnapshot {
  private snapshots: Map<string, Snapshot> = new Map();

  /**
   * Captures in-memory state before any edit is touched
   */
  public snapshot(filePath: string): void {
    const fullPath = path.resolve(filePath);
    if (fs.existsSync(fullPath)) {
      this.snapshots.set(fullPath, {
        filePath: fullPath,
        originalContent: fs.readFileSync(fullPath, "utf-8"),
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Reverts file to snapshot if test/compiler check fails
   */
  public rollback(filePath: string): boolean {
    const fullPath = path.resolve(filePath);
    const snap = this.snapshots.get(fullPath);
    if (snap) {
      fs.writeFileSync(fullPath, snap.originalContent, "utf-8");
      console.warn(`[SafetySnapshot] Reverted ${path.basename(fullPath)} to pre-edit state.`);
      return true;
    }
    return false;
  }

  public commit(filePath: string): void {
    const fullPath = path.resolve(filePath);
    this.snapshots.delete(fullPath);
  }
}
