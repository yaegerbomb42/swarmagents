import { GroqClient } from "./groqClient.js";
import { AstSlicer } from "./astSlicer.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface TestGenResult {
  success: boolean;
  testFilePath: string;
  testPassed: boolean;
  output: string;
}

export class AutoTestGenerator {
  private client: GroqClient;

  constructor(client?: GroqClient) {
    this.client = client || new GroqClient();
  }

  /**
   * Reads a target function/file slice and generates a standalone executable test (.mjs)
   * that verifies functionality using native node assertions.
   */
  public async generateAndRunVerificationTest(
    targetFilePath: string,
    functionName: string,
    startLine: number = 1,
    endLine: number = 60
  ): Promise<TestGenResult> {
    const slice = AstSlicer.readSlice(targetFilePath, startLine, endLine);
    const testFilePath = path.resolve(
      path.dirname(targetFilePath),
      `temp_${functionName.toLowerCase()}_test.mjs`
    );

    const prompt = [
      `TARGET FILE: ${targetFilePath}`,
      `CODE SLICE:`,
      slice.content,
      ``,
      `TASK: Write a standalone Node.js verification script in ES module (.mjs) format for '${functionName}'.`,
      `RULES:`,
      `1. Import the target function using relative import: import { ${functionName} } from './${path.basename(targetFilePath)}';`,
      `2. Use import assert from 'node:assert'; to test normal and edge cases.`,
      `3. Log 'TEST_PASSED' on completion.`,
      `4. Output ONLY valid JS code inside markdown \`\`\`javascript codeblock. No conversational text.`,
    ].join("\n");

    try {
      const completion = await this.client.chatCompletion(
        [
          { role: "system", content: "You are an automated unit test generator. Output raw javascript test code only." },
          { role: "user", content: prompt },
        ],
        { model: this.client.defaultModel, max_tokens: 600 }
      );

      let code = completion.content;
      const match = code.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
      if (match) code = match[1];

      fs.writeFileSync(testFilePath, code.trim(), "utf-8");

      // Execute test
      try {
        const out = execSync(`node "${testFilePath}"`, { encoding: "utf-8", timeout: 5000 });
        const passed = out.includes("TEST_PASSED") || out.trim() === "";
        return {
          success: true,
          testFilePath,
          testPassed: passed,
          output: out.trim() || "All assertions passed.",
        };
      } catch (execErr: any) {
        return {
          success: true,
          testFilePath,
          testPassed: false,
          output: (execErr.stdout || "") + "\n" + (execErr.stderr || "") + "\n" + execErr.message,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        testFilePath,
        testPassed: false,
        output: err.message,
      };
    }
  }
}
