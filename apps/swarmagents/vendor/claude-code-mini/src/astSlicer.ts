import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface FileSlice {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export class AstSlicer {
  /**
   * Generates a compact symbol outline of a file using grep/regex or ctags.
   * Keeps token footprint tiny (<150 tokens) instead of reading the file.
   */
  public static getFileOutline(filePath: string): string {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
    const outline: string[] = [];

    // Extract function, class, interface, export signatures with line numbers
    const sigRegex = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const|let|var|def|fn)\s+([a-zA-Z0-9_$]+)/;

    lines.forEach((line, idx) => {
      const match = line.match(sigRegex);
      if (match) {
        const lineNum = idx + 1;
        outline.push(`L${lineNum}: ${line.trim().slice(0, 80)}`);
      }
    });

    if (outline.length === 0) {
      return `Total Lines: ${lines.length}. (No major exported symbols found)`;
    }

    return `File: ${path.basename(filePath)} (${lines.length} lines)\n` + outline.slice(0, 35).join("\n");
  }

  /**
   * Surgical window reader: fetches only [startLine, endLine] with line numbers.
   */
  public static readSlice(filePath: string, startLine: number, endLine: number): FileSlice {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const allLines = fs.readFileSync(fullPath, "utf-8").split("\n");
    const safeStart = Math.max(1, startLine);
    const safeEnd = Math.min(allLines.length, endLine);

    const slice = allLines.slice(safeStart - 1, safeEnd);
    const numberedSlice = slice.map((line, idx) => `${safeStart + idx} | ${line}`).join("\n");

    return {
      filePath: fullPath,
      startLine: safeStart,
      endLine: safeEnd,
      totalLines: allLines.length,
      content: numberedSlice,
    };
  }

  /**
   * Applies a surgical replacement without rewriting the entire file.
   * Supports exact matching and normalized whitespace/indentation matching.
   */
  public static applySlicePatch(filePath: string, targetText: string, replacementText: string): boolean {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");

    // 1. Direct exact match
    if (content.includes(targetText)) {
      const updated = content.replace(targetText, replacementText);
      fs.writeFileSync(fullPath, updated, "utf-8");
      return true;
    }

    // 2. Normalized newline & whitespace matching (protects against model formatting drifts)
    const normalize = (str: string) => str.replace(/\r\n/g, "\n").trim();
    const normalizedTarget = normalize(targetText);
    const lines = content.split("\n");
    const targetLines = normalizedTarget.split("\n").map((l) => l.trim());

    for (let i = 0; i <= lines.length - targetLines.length; i++) {
      let match = true;
      for (let j = 0; j < targetLines.length; j++) {
        if (lines[i + j].trim() !== targetLines[j]) {
          match = false;
          break;
        }
      }

      if (match) {
        // Found matching line range [i, i + targetLines.length]
        const before = lines.slice(0, i);
        const after = lines.slice(i + targetLines.length);
        const updated = [...before, replacementText, ...after].join("\n");
        fs.writeFileSync(fullPath, updated, "utf-8");
        return true;
      }
    }

    throw new Error(`Target text block not found in ${filePath} for surgical patch.`);
  }
}
