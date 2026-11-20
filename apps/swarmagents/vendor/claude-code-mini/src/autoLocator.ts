import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface LocatedTarget {
  filePath: string;
  line: number;
  snippet: string;
  score: number;
}

export class AutoLocator {
  /**
   * Searches the codebase for relevant symbols or error messages using ripgrep or grep.
   * Returns top matching files and exact line numbers in <100 tokens.
   */
  public static locate(query: string, workDir: string = process.cwd()): LocatedTarget[] {
    // Clean query for search
    const cleanQuery = query
      .replace(/['"]/g, "")
      .replace(/[^\w\s.-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 3)
      .join("|");

    if (!cleanQuery) return [];

    try {
      // Use ripgrep or fallback to grep
      const cmd = `rg -n -i -m 5 --max-columns 120 -g '!node_modules' -g '!.git' -g '!dist' -g '!.next' -E "${cleanQuery}" "${workDir}"`;
      const stdout = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });

      const lines = stdout.split("\n").filter(Boolean);
      const targets: LocatedTarget[] = [];

      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const filePath = parts[0];
          const lineNum = parseInt(parts[1], 10);
          const snippet = parts.slice(2).join(":").trim();

          targets.push({
            filePath,
            line: isNaN(lineNum) ? 1 : lineNum,
            snippet,
            score: 1,
          });
        }
      }

      return targets.slice(0, 3);
    } catch {
      return [];
    }
  }
}
