import type { LexToken, OperatorKind, RedirectOp, WordToken } from "./types";

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
  tokenRef: Extract<LexToken, { type: "redirect" }>;
}

const SINGLE_CHAR_OPS = new Set([";", "|", "&", "(", ")"]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

function isVarStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isVarChar(ch: string): boolean {
  return isVarStart(ch) || isDigit(ch);
}

/**
 * Scans balanced `(...)` starting at `startIdx` where `src[startIdx] === "("`.
 * Respects single quotes, double quotes, ANSI-C quotes, backslashes, and nested parens.
 */
function scanBalancedParens(
  src: string,
  startIdx: number,
): { inner: string; endIdx: number } {
  let depth = 1;
  let i = startIdx + 1;
  const len = src.length;

  while (i < len && depth > 0) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < len && src[i] !== "'") i++;
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < len && src[i] !== '"') {
        if (src[i] === "\\") {
          i += 2;
        } else {
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return {
          inner: src.slice(startIdx + 1, i),
          endIdx: i + 1,
        };
      }
    }
    i++;
  }

  return {
    inner: src.slice(startIdx + 1, len),
    endIdx: len,
  };
}

/**
 * Scans balanced `${...}` starting at `startIdx` where `src.slice(startIdx, startIdx + 2) === "${"`.
 */
function scanBalancedBraces(
  src: string,
  startIdx: number,
): { content: string; endIdx: number } {
  let depth = 1;
  let i = startIdx + 2;
  const len = src.length;

  while (i < len && depth > 0) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < len && src[i] !== "'") i++;
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < len && src[i] !== '"') {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return {
          content: src.slice(startIdx + 2, i),
          endIdx: i + 1,
        };
      }
    }
    i++;
  }

  return {
    content: src.slice(startIdx + 2, len),
    endIdx: len,
  };
}

/**
 * Scans backtick command substitution starting at `startIdx` where `src[startIdx] === "`"`.
 */
function scanBackticks(
  src: string,
  startIdx: number,
): { inner: string; endIdx: number } {
  let i = startIdx + 1;
  const len = src.length;
  let inner = "";

  while (i < len) {
    const ch = src[i]!;
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "`" || next === "\\" || next === "$") {
        inner += next;
        i += 2;
        continue;
      }
    }
    if (ch === "`") {
      return { inner, endIdx: i + 1 };
    }
    inner += ch;
    i++;
  }

  return { inner, endIdx: len };
}

/**
 * Decodes ANSI-C `$'...'` string literals and flags hex/octal obfuscation escapes.
 */
function scanAnsiCQuote(
  src: string,
  startIdx: number,
): { decoded: string; endIdx: number; hasHexOrOctal: boolean } {
  let i = startIdx + 2; // skip $'
  const len = src.length;
  let decoded = "";
  let hasHexOrOctal = false;

  while (i < len) {
    const ch = src[i]!;
    if (ch === "'") {
      return { decoded, endIdx: i + 1, hasHexOrOctal };
    }
    if (ch === "\\" && i + 1 < len) {
      const esc = src[i + 1]!;
      switch (esc) {
        case "n":
          decoded += "\n";
          i += 2;
          break;
        case "t":
          decoded += "\t";
          i += 2;
          break;
        case "r":
          decoded += "\r";
          i += 2;
          break;
        case "a":
          decoded += "\x07";
          i += 2;
          break;
        case "b":
          decoded += "\b";
          i += 2;
          break;
        case "e":
        case "E":
          decoded += "\x1b";
          i += 2;
          break;
        case "f":
          decoded += "\f";
          i += 2;
          break;
        case "v":
          decoded += "\v";
          i += 2;
          break;
        case "\\":
          decoded += "\\";
          i += 2;
          break;
        case "'":
          decoded += "'";
          i += 2;
          break;
        case '"':
          decoded += '"';
          i += 2;
          break;
        case "x": {
          hasHexOrOctal = true;
          let hex = "";
          let j = i + 2;
          while (j < len && hex.length < 2 && isHexDigit(src[j]!)) {
            hex += src[j]!;
            j++;
          }
          if (hex.length > 0) {
            decoded += String.fromCharCode(parseInt(hex, 16));
            i = j;
          } else {
            decoded += "\\x";
            i += 2;
          }
          break;
        }
        case "u":
        case "U": {
          hasHexOrOctal = true;
          const maxLen = esc === "u" ? 4 : 8;
          let hex = "";
          let j = i + 2;
          while (j < len && hex.length < maxLen && isHexDigit(src[j]!)) {
            hex += src[j]!;
            j++;
          }
          if (hex.length > 0) {
            const code = parseInt(hex, 16);
            if (code >= 0 && code <= 0x10ffff) {
              decoded += String.fromCodePoint(code);
            }
            i = j;
          } else {
            decoded += `\\${esc}`;
            i += 2;
          }
          break;
        }
        default: {
          if (isOctalDigit(esc)) {
            hasHexOrOctal = true;
            let oct = "";
            let j = i + 1;
            while (j < len && oct.length < 3 && isOctalDigit(src[j]!)) {
              oct += src[j]!;
              j++;
            }
            decoded += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = j;
          } else {
            decoded += esc;
            i += 2;
          }
          break;
        }
      }
    } else {
      decoded += ch;
      i++;
    }
  }

  return { decoded, endIdx: len, hasHexOrOctal };
}

export function tokenizeBash(command: string): LexToken[] {
  const tokens: LexToken[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  const len = command.length;
  let i = 0;

  const consumeHeredocs = () => {
    while (pendingHeredocs.length > 0 && i < len) {
      const hd = pendingHeredocs.shift()!;
      const bodyLines: string[] = [];
      while (i < len) {
        const nlIdx = command.indexOf("\n", i);
        const lineEnd = nlIdx === -1 ? len : nlIdx;
        const rawLine = command.slice(i, lineEnd);
        i = nlIdx === -1 ? len : nlIdx + 1;
        const candidate = hd.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        if (candidate === hd.delimiter) {
          break;
        }
        bodyLines.push(candidate);
      }
      hd.tokenRef.heredocBody = bodyLines.join("\n");
    }
  };

  while (i < len) {
    const ch = command[i]!;

    // Horizontal whitespace
    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    // Backslash-newline line continuation outside quotes
    if (ch === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }

    // Newline (also triggers pending heredoc consumption)
    if (ch === "\n") {
      i++;
      tokens.push({ type: "op", op: "\n" });
      if (pendingHeredocs.length > 0) {
        consumeHeredocs();
      }
      continue;
    }

    // Comments (# at start of token)
    if (ch === "#") {
      while (i < len && command[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Check for fd-prefixed redirections like 2>, 1>>, 0<, 2>&1
    let fdPrefix: number | undefined;
    let lookIdx = i;
    if (isDigit(ch)) {
      let digitEnd = i;
      while (digitEnd < len && isDigit(command[digitEnd]!)) {
        digitEnd++;
      }
      const nextAfterDigits = command[digitEnd];
      if (nextAfterDigits === ">" || nextAfterDigits === "<") {
        fdPrefix = parseInt(command.slice(i, digitEnd), 10);
        lookIdx = digitEnd;
      }
    }

    const opChar = command[lookIdx]!;

    // Redirections (<, >, <<, >>, <<<, <>, >|, &>, &>>, >&, <&)
    if (
      opChar === ">" ||
      opChar === "<" ||
      (fdPrefix === undefined &&
        ch === "&" &&
        (command[i + 1] === ">" || command.slice(i, i + 3) === "&>>"))
    ) {
      // Check process substitution <(...) or >(...) when no fdPrefix
      if (
        fdPrefix === undefined &&
        (opChar === "<" || opChar === ">") &&
        command[lookIdx + 1] === "("
      ) {
        // Handled as a word token below
      } else {
        let redirOp: RedirectOp;
        let nextIdx = lookIdx;

        if (fdPrefix === undefined && command.slice(i, i + 3) === "&>>") {
          redirOp = "&>>";
          nextIdx = i + 3;
        } else if (fdPrefix === undefined && command.slice(i, i + 2) === "&>") {
          redirOp = "&>";
          nextIdx = i + 2;
        } else if (command.slice(lookIdx, lookIdx + 3) === "<<<") {
          redirOp = "<<<";
          nextIdx = lookIdx + 3;
        } else if (command.slice(lookIdx, lookIdx + 3) === "<<-") {
          redirOp = "<<-";
          nextIdx = lookIdx + 3;
        } else if (command.slice(lookIdx, lookIdx + 2) === "<<") {
          redirOp = "<<";
          nextIdx = lookIdx + 2;
        } else if (command.slice(lookIdx, lookIdx + 2) === ">>") {
          redirOp = ">>";
          nextIdx = lookIdx + 2;
        } else if (command.slice(lookIdx, lookIdx + 2) === ">|") {
          redirOp = ">|";
          nextIdx = lookIdx + 2;
        } else if (command.slice(lookIdx, lookIdx + 2) === "<>") {
          redirOp = "<>";
          nextIdx = lookIdx + 2;
        } else if (command.slice(lookIdx, lookIdx + 2) === ">&") {
          redirOp = ">&";
          nextIdx = lookIdx + 2;
        } else if (command.slice(lookIdx, lookIdx + 2) === "<&") {
          redirOp = "<&";
          nextIdx = lookIdx + 2;
        } else if (opChar === ">") {
          redirOp = ">";
          nextIdx = lookIdx + 1;
        } else {
          redirOp = "<";
          nextIdx = lookIdx + 1;
        }

        i = nextIdx;
        while (i < len && isWhitespace(command[i]!)) i++;
        const targetWord = readWordToken();
        const redirToken: Extract<LexToken, { type: "redirect" }> = {
          type: "redirect",
          fd: fdPrefix,
          op: redirOp,
          target: targetWord,
        };
        tokens.push(redirToken);

        if (redirOp === "<<" || redirOp === "<<-") {
          pendingHeredocs.push({
            delimiter: targetWord.value,
            stripTabs: redirOp === "<<-",
            quoted: targetWord.hasQuotes,
            tokenRef: redirToken,
          });
        }
        continue;
      }
    }

    // Two-char control operators: &&, ||, |&
    const twoChar = command.slice(i, i + 2);
    if (twoChar === "&&" || twoChar === "||" || twoChar === "|&") {
      tokens.push({ type: "op", op: twoChar as OperatorKind });
      i += 2;
      continue;
    }

    // Single-char control operators: ;, |, &, (, )
    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: "op", op: ch as OperatorKind });
      i++;
      continue;
    }

    // Standalone `{` or `}` as reserved word operator when delimited
    if (
      (ch === "{" || ch === "}") &&
      (i + 1 >= len ||
        isWhitespace(command[i + 1]!) ||
        command[i + 1] === "\n" ||
        command[i + 1] === ";")
    ) {
      tokens.push({ type: "op", op: ch as OperatorKind });
      i++;
      continue;
    }

    // Otherwise scan a complete shell word
    const word = readWordToken();
    if (word.raw.length > 0 || word.hasQuotes) {
      tokens.push({ type: "word", word });
    } else {
      i++;
    }
  }

  // If heredoc delimiter was never closed before EOF, still attach remaining lines if any
  if (pendingHeredocs.length > 0 && i < len) {
    consumeHeredocs();
  }

  return tokens;

  function readWordToken(): WordToken {
    const startIdx = i;
    let value = "";
    let hasQuotes = false;
    let sawSingleQuote = false;
    let sawOtherContent = false;
    let midWordQuoted = false;
    let hasExpansion = false;
    let hasHexOrOctalEscape = false;
    const subcommands: string[] = [];
    const variables: string[] = [];

    while (i < len) {
      const c = command[i]!;

      // Unquoted word delimiters
      if (
        isWhitespace(c) ||
        c === "\n" ||
        c === ";" ||
        c === "|" ||
        c === "&" ||
        c === "(" ||
        c === ")"
      ) {
        break;
      }

      // Unquoted redirection starts break word (except <(...) and >(...))
      if ((c === "<" || c === ">") && command[i + 1] !== "(") {
        break;
      }

      // Process substitution <(...) or >(...)
      if ((c === "<" || c === ">") && command[i + 1] === "(") {
        hasExpansion = true;
        const { inner, endIdx } = scanBalancedParens(command, i + 1);
        subcommands.push(inner);
        value += command.slice(i, endIdx);
        i = endIdx;
        sawOtherContent = true;
        continue;
      }

      // Backslash escape outside quotes
      if (c === "\\") {
        if (command[i + 1] === "\n") {
          i += 2;
          continue;
        }
        if (i + 1 < len) {
          if (i > startIdx) {
            midWordQuoted = true;
          }
          value += command[i + 1]!;
          i += 2;
          sawOtherContent = true;
          continue;
        }
        value += "\\";
        i++;
        sawOtherContent = true;
        continue;
      }

      // ANSI-C quoting $'...'
      if (c === "$" && command[i + 1] === "'") {
        if (i > startIdx) midWordQuoted = true;
        hasQuotes = true;
        const res = scanAnsiCQuote(command, i);
        value += res.decoded;
        if (res.hasHexOrOctal) hasHexOrOctalEscape = true;
        i = res.endIdx;
        sawOtherContent = true;
        continue;
      }

      // Locale double quote $"..."
      if (c === "$" && command[i + 1] === '"') {
        i++; // fall through to double quote handler
        continue;
      }

      // Single quotes '...'
      if (c === "'") {
        if (i > startIdx) midWordQuoted = true;
        hasQuotes = true;
        sawSingleQuote = true;
        i++;
        while (i < len && command[i] !== "'") {
          value += command[i]!;
          i++;
        }
        if (i < len && command[i] === "'") i++;
        continue;
      }

      // Double quotes "..."
      if (c === '"') {
        if (i > startIdx) midWordQuoted = true;
        hasQuotes = true;
        sawOtherContent = true;
        i++;
        while (i < len && command[i] !== '"') {
          const dc = command[i]!;
          if (dc === "\\") {
            const nxt = command[i + 1];
            if (nxt === "\n") {
              i += 2;
              continue;
            }
            if (
              nxt === '"' ||
              nxt === "\\" ||
              nxt === "$" ||
              nxt === "`"
            ) {
              value += nxt;
              i += 2;
              continue;
            }
          }
          if (dc === "`") {
            hasExpansion = true;
            const bt = scanBackticks(command, i);
            subcommands.push(bt.inner);
            value += command.slice(i, bt.endIdx);
            i = bt.endIdx;
            continue;
          }
          if (dc === "$") {
            const exp = consumeDollarExpansion();
            value += exp;
            continue;
          }
          value += dc;
          i++;
        }
        if (i < len && command[i] === '"') i++;
        continue;
      }

      // Backticks `...`
      if (c === "`") {
        hasExpansion = true;
        sawOtherContent = true;
        const bt = scanBackticks(command, i);
        subcommands.push(bt.inner);
        value += command.slice(i, bt.endIdx);
        i = bt.endIdx;
        continue;
      }

      // Dollar expansions: $((...)), $(...), ${...}, $VAR
      if (c === "$") {
        sawOtherContent = true;
        const exp = consumeDollarExpansion();
        value += exp;
        continue;
      }

      value += c;
      sawOtherContent = true;
      i++;
    }

    return {
      raw: command.slice(startIdx, i),
      value,
      hasQuotes,
      singleQuoted: sawSingleQuote && !sawOtherContent,
      midWordQuoted,
      hasExpansion,
      hasHexOrOctalEscape,
      subcommands,
      variables,
    };

    function consumeDollarExpansion(): string {
      // Arithmetic expansion $(( ... ))
      if (command.slice(i, i + 3) === "$((") {
        hasExpansion = true;
        const { endIdx } = scanBalancedParens(command, i + 1);
        const slice = command.slice(i, endIdx);
        i = endIdx;
        return slice;
      }
      // Command substitution $( ... )
      if (command[i + 1] === "(") {
        hasExpansion = true;
        const { inner, endIdx } = scanBalancedParens(command, i + 1);
        subcommands.push(inner);
        const slice = command.slice(i, endIdx);
        i = endIdx;
        return slice;
      }
      // Braced parameter expansion ${ ... }
      if (command[i + 1] === "{") {
        hasExpansion = true;
        const { content, endIdx } = scanBalancedBraces(command, i);
        const varMatch = /^[!#]?([a-zA-Z_][a-zA-Z0-9_]*)/.exec(content);
        if (varMatch && varMatch[1]) {
          variables.push(varMatch[1]);
        }
        const slice = command.slice(i, endIdx);
        i = endIdx;
        return slice;
      }
      // Simple variable $VAR
      if (i + 1 < len && isVarStart(command[i + 1]!)) {
        hasExpansion = true;
        let endVar = i + 2;
        while (endVar < len && isVarChar(command[endVar]!)) {
          endVar++;
        }
        const varName = command.slice(i + 1, endVar);
        variables.push(varName);
        const slice = command.slice(i, endVar);
        i = endVar;
        return slice;
      }
      // Special parameters $@, $*, $#, $?, $-, $$, $!, $0..$9
      if (
        i + 1 < len &&
        "@*#?-$!0123456789".includes(command[i + 1]!)
      ) {
        hasExpansion = true;
        const slice = command.slice(i, i + 2);
        variables.push(command[i + 1]!);
        i += 2;
        return slice;
      }

      i++;
      return "$";
    }
  }
}
