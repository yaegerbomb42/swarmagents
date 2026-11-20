export class InteractiveDiffViewer {
  /**
   * Renders a colored, git-style unified diff in the terminal
   */
  public static renderDiff(search: string, replace: string, filePath: string): string {
    const searchLines = search.split("\n");
    const replaceLines = replace.split("\n");

    const header = `\x1b[1m--- a/${filePath}\n+++ b/${filePath}\x1b[0m\n`;
    const removed = searchLines.map((l) => `\x1b[31m- ${l}\x1b[0m`).join("\n");
    const added = replaceLines.map((l) => `\x1b[32m+ ${l}\x1b[0m`).join("\n");

    return `${header}${removed}\n${added}\n`;
  }
}
