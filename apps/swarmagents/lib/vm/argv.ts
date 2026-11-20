// Conversion of a user-typed terminal line into an argv array for VmManager.
//
// The exec API accepts both a plain string ("ls -la") and an argv array
// (["ls", "-la"]). Strings are tokenized with a small POSIX-like grammar:
// whitespace separates words, single quotes hold their content literally,
// double quotes allow \ " \ \ and \$ escapes, and a backslash outside quotes
// escapes the next character. Unbalanced quotes return null so the caller can
// reject the line instead of guessing.

export const SHELL_MAX_ARGS = 100;
export const SHELL_MAX_ARG_LEN = 2048;
export const SHELL_MAX_CMD_LEN = 8192;

export function tokenizeShellCommand(input: string): string[] | null {
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const finishWord = () => {
    if (inWord) {
      argv.push(word);
      word = "";
      inWord = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"') {
        // Inside double quotes a backslash only escapes ", \ and $.
        const next = input[i + 1];
        if (next === '"' || next === "\\" || next === "$") {
          word += next;
          i++;
        } else {
          word += ch;
        }
      } else {
        word += ch;
      }
      inWord = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }

    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) {
        word += ch;
      } else {
        word += next;
        i++;
      }
      inWord = true;
      continue;
    }

    if (/\s/.test(ch)) {
      finishWord();
      continue;
    }

    word += ch;
    inWord = true;
  }

  if (quote) return null;
  finishWord();
  return argv;
}

/** Rejoin argv into a single command text (for the risk classifier / display). */
export function shellCommandText(argv: string[]): string {
  return argv.join(" ");
}
