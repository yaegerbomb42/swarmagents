import { execSync } from "child_process";
import * as path from "path";

export interface ReferenceTarget {
  sourceFile: string;
  sourceLine: number;
  referencingFile: string;
  referencingLine: number;
  snippet: string;
}

export class DependencyRadarTool {
  /**
   * Scans the repo for any other files that import or reference the target symbol.
   * Prevents cross-file breakages by finding downstream dependents in <100 tokens.
   */
  public static scanDependents(symbolName: string, workDir: string = process.cwd()): ReferenceTarget[] {
    if (!symbolName || symbolName.length < 3) return [];

    try {
      const cleanSymbol = symbolName.trim();
      const cmd = `rg -n -m 8 -g '!node_modules' -g '!.git' -g '!dist' -g '!.next' "\\b${cleanSymbol}\\b" "${workDir}"`;
      const stdout = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });

      const lines = stdout.split("\n").filter(Boolean);
      const results: ReferenceTarget[] = [];

      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const referencingFile = parts[0];
          const referencingLine = parseInt(parts[1], 10);
          const snippet = parts.slice(2).join(":").trim();

          results.push({
            sourceFile: "",
            sourceLine: 0,
            referencingFile,
            referencingLine: isNaN(referencingLine) ? 1 : referencingLine,
            snippet,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Compact prompt representation of downstream ripple effects (<120 tokens).
   */
  public static getRadarPrompt(symbolName: string, dependents: ReferenceTarget[]): string {
    if (dependents.length === 0) {
      return `DEPENDENCY RADAR: No external references found for '${symbolName}'. Safe to edit in isolation.`;
    }

    const lines = dependents.slice(0, 5).map(
      (d) => `- ${path.basename(d.referencingFile)}:${d.referencingLine} -> "${d.snippet.slice(0, 70)}"`
    );

    return `DEPENDENCY RADAR (Ripple effects for '${symbolName}'):\n` + lines.join("\n");
  }
}
