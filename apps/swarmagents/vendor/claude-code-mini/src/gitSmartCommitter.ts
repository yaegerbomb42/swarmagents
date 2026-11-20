import { GroqClient } from "./groqClient.js";
import { execSync } from "child_process";

export interface GitCommitResult {
  success: boolean;
  commitMessage: string;
  filesCommitted: string[];
  output: string;
}

export class GitSmartCommitter {
  private client: GroqClient;

  constructor(client?: GroqClient) {
    this.client = client || new GroqClient();
  }

  /**
   * Reads staged or unstaged git diff, generates a conventional commit message,
   * and executes git commit cleanly.
   */
  public async smartCommit(autoStageAll: boolean = true): Promise<GitCommitResult> {
    try {
      if (autoStageAll) {
        execSync("git add -u", { encoding: "utf-8" });
      }

      const diff = execSync("git diff --cached", { encoding: "utf-8" }).trim();
      if (!diff) {
        return {
          success: false,
          commitMessage: "",
          filesCommitted: [],
          output: "No staged changes to commit.",
        };
      }

      // Slice diff to <1,500 chars to protect token budget
      const slicedDiff = diff.slice(0, 3000);

      const prompt = [
        "TASK: Generate a concise, conventional git commit message based on this diff.",
        "FORMAT: <type>(<scope>): <short description>",
        "EXAMPLES:",
        "- fix(auth): correct token expiration check and handle missing bearer header",
        "- refactor(keypool): add rotating cooldown tracking for groq multi-pool",
        "RULES: Output ONLY the 1-line commit message. No quotes, no markdown, no explanation.",
        "",
        "DIFF:",
        slicedDiff,
      ].join("\n");

      const res = await this.client.chatCompletion(
        [
          { role: "system", content: "You are an automated git commit assistant. Output only a 1-line conventional commit message." },
          { role: "user", content: prompt },
        ],
        { model: this.client.fastModel, max_tokens: 50, temperature: 0.1 }
      );

      const commitMsg = res.content.trim().replace(/^["']|["']$/g, "");
      const commitOut = execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });

      const files = execSync("git diff --name-only HEAD~1", { encoding: "utf-8" })
        .split("\n")
        .filter(Boolean);

      return {
        success: true,
        commitMessage: commitMsg,
        filesCommitted: files,
        output: commitOut.trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        commitMessage: "",
        filesCommitted: [],
        output: err.message,
      };
    }
  }
}
