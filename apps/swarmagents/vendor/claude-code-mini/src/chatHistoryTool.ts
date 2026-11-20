import { GroqClient } from "./groqClient.js";
import { ContextGovernor } from "./contextGovernor.js";
import * as fs from "fs";
import * as path from "path";

export interface HistoryTurn {
  turnIndex: number;
  userPrompt: string;
  filesTouched: string[];
  summary: string;
  timestamp: number;
}

export class ChatHistoryTool {
  private client: GroqClient;
  private historyFilePath: string;
  private history: HistoryTurn[] = [];

  constructor(client: GroqClient, workDir: string = process.cwd()) {
    this.client = client;
    this.historyFilePath = path.join(workDir, ".claude_mini_history.json");
    this.load();
  }

  private load() {
    if (fs.existsSync(this.historyFilePath)) {
      try {
        this.history = JSON.parse(fs.readFileSync(this.historyFilePath, "utf-8"));
      } catch {}
    }
  }

  private save() {
    fs.writeFileSync(this.historyFilePath, JSON.stringify(this.history, null, 2), "utf-8");
  }

  /**
   * Records a turn, automatically summarizing it to <80 tokens using the fast model.
   */
  public async recordTurn(userPrompt: string, filesTouched: string[], rawOutcome: string): Promise<void> {
    let summary = rawOutcome.slice(0, 150);

    try {
      const res = await this.client.chatCompletion(
        [
          { role: "system", content: "Summarize this agent action in exactly 1 factual sentence (<20 words)." },
          { role: "user", content: `Prompt: ${userPrompt}\nAction: ${rawOutcome}` },
        ],
        { model: this.client.fastModel, max_tokens: 40 }
      );
      summary = res.content.trim() || summary;
    } catch {}

    this.history.push({
      turnIndex: this.history.length + 1,
      userPrompt: userPrompt.slice(0, 100),
      filesTouched,
      summary,
      timestamp: Date.now(),
    });

    // Keep last 15 turns max
    if (this.history.length > 15) {
      this.history = this.history.slice(-15);
    }
    this.save();
  }

  /**
   * Formats the rolling condensed chat history into a tiny ~200 token block for the prompt.
   */
  public getCondensedHistoryPrompt(): string {
    if (this.history.length === 0) return "Chat History: Fresh session (no prior turns).";

    const lines = this.history.map(
      (h) => `[Turn ${h.turnIndex}] Prompt: "${h.userPrompt}" -> Summary: ${h.summary} (Files: ${h.filesTouched.map((f) => path.basename(f)).join(", ") || "none"})`
    );

    return `CONDENSED CHAT HISTORY (Last ${this.history.length} turns):\n` + lines.join("\n");
  }

  public clear(): void {
    this.history = [];
    if (fs.existsSync(this.historyFilePath)) {
      fs.unlinkSync(this.historyFilePath);
    }
  }
}
