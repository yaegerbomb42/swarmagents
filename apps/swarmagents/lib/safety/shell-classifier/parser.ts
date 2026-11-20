import type {
  CommandNode,
  EnvAssignment,
  LexToken,
  PipelineNode,
  PipelineSegment,
  RedirectNode,
  SimpleCommandNode,
  WordToken,
} from "./types";

const ENV_ASSIGN_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/s;
const FUNC_NAME_RE = /^[a-zA-Z_.:][a-zA-Z0-9_.:-]*$/;

const COMPOUND_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "time",
  "coproc",
]);

export function parseBashTokens(tokens: LexToken[]): PipelineNode[] {
  let pos = 0;
  const len = tokens.length;

  function peekOp(offset = 0): string | undefined {
    const t = peek(offset);
    return t?.type === "op" ? t.op : undefined;
  }

  function peek(offset = 0): LexToken | undefined {
    return tokens[pos + offset];
  }

  function consume(): LexToken | undefined {
    return tokens[pos++];
  }

  function skipSeparators(): void {
    while (pos < len) {
      const tok = tokens[pos]!;
      if (tok.type === "op" && (tok.op === ";" || tok.op === "\n")) {
        pos++;
      } else {
        break;
      }
    }
  }

  function parseProgram(stopOps?: Set<string>): PipelineNode[] {
    const pipelines: PipelineNode[] = [];
    skipSeparators();

    while (pos < len) {
      const tok = peek()!;
      if (tok.type === "op" && stopOps && stopOps.has(tok.op)) {
        break;
      }
      const pipeline = parsePipeline(stopOps);
      if (pipeline) {
        pipelines.push(pipeline);
      } else {
        // Guard against unexpected token stall
        pos++;
      }
      skipSeparators();
    }

    return pipelines;
  }

  function parsePipeline(stopOps?: Set<string>): PipelineNode | null {
    skipSeparators();
    if (pos >= len) return null;

    let negated = false;
    const first = peek();
    if (first?.type === "word" && first.word.raw === "!") {
      negated = true;
      consume();
    }

    const segments: PipelineSegment[] = [];

    while (pos < len) {
      const tok = peek()!;
      if (tok.type === "op" && stopOps && stopOps.has(tok.op)) {
        break;
      }

      const cmd = parseCommand();
      if (!cmd) break;

      const next = peek();
      if (next?.type === "op" && (next.op === "|" || next.op === "|&")) {
        consume();
        segments.push({ command: cmd, pipeOp: next.op });
        // Allow newlines after pipe
        while (peekOp() === "\n") {
          consume();
        }
        continue;
      }

      segments.push({ command: cmd });
      break;
    }

    if (segments.length === 0) return null;

    let terminator: PipelineNode["terminator"];
    const after = peek();
    if (
      after?.type === "op" &&
      (after.op === ";" ||
        after.op === "&&" ||
        after.op === "||" ||
        after.op === "&" ||
        after.op === "\n")
    ) {
      terminator = after.op;
      consume();
    }

    return {
      negated,
      segments,
      terminator,
    };
  }

  function parseCommand(): CommandNode | null {
    const tok = peek();
    if (!tok) return null;

    // Subshell: ( ... )
    if (tok.type === "op" && tok.op === "(") {
      consume();
      const inner = parseProgram(new Set([")"]));
      if (peekOp() === ")") {
        consume();
      }
      const redirects = collectTrailingRedirects();
      return {
        kind: "subshell",
        pipelines: inner,
        redirects,
      };
    }

    // Brace group: { ... }
    if (tok.type === "op" && tok.op === "{") {
      consume();
      const inner = parseProgram(new Set(["}"]));
      if (peekOp() === "}") {
        consume();
      }
      const redirects = collectTrailingRedirects();
      return {
        kind: "group",
        pipelines: inner,
        redirects,
      };
    }

    // Function definition shorthand: name() { ... } or name() ( ... )
    if (
      tok.type === "word" &&
      !tok.word.hasQuotes &&
      FUNC_NAME_RE.test(tok.word.value) &&
      peekOp(1) === "(" &&
      peekOp(2) === ")"
    ) {
      const funcName = tok.word.value;
      pos += 3;
      while (peekOp() === "\n") consume();
      const body = parseCommand();
      if (body) {
        return {
          kind: "function",
          name: funcName,
          body,
        };
      }
    }

    // `function name { ... }` syntax
    if (
      tok.type === "word" &&
      !tok.word.hasQuotes &&
      tok.word.value === "function" &&
      peek(1)?.type === "word"
    ) {
      consume(); // consume `function`
      const nameTok = consume() as Extract<LexToken, { type: "word" }>;
      if (
        peekOp() === "(" &&
        peekOp(1) === ")"
      ) {
        pos += 2;
      }
      while (peekOp() === "\n") consume();
      const body = parseCommand();
      if (body) {
        return {
          kind: "function",
          name: nameTok.word.value,
          body,
        };
      }
    }

    // Strip leading shell control keywords so commands inside if/for/while/case are parsed cleanly
    if (
      tok.type === "word" &&
      !tok.word.hasQuotes &&
      COMPOUND_KEYWORDS.has(tok.word.value)
    ) {
      const kw = tok.word.value;
      consume();
      // For `for VAR in ...` or `case WORD in`, skip header words until `;` or `\n` or `do`
      if (kw === "for" || kw === "select" || kw === "case") {
        while (pos < len) {
          const cur = peek()!;
          if (cur.type === "op" && (cur.op === ";" || cur.op === "\n")) {
            consume();
            break;
          }
          if (
            cur.type === "word" &&
            !cur.word.hasQuotes &&
            cur.word.value === "do"
          ) {
            consume();
            break;
          }
          consume();
        }
      }
      return parseCommand();
    }

    return parseSimpleCommand();
  }

  function parseSimpleCommand(): SimpleCommandNode | null {
    const envAssignments: EnvAssignment[] = [];
    const argv: WordToken[] = [];
    const redirects: RedirectNode[] = [];

    while (pos < len) {
      const tok = peek()!;
      if (tok.type === "op") {
        break;
      }
      if (tok.type === "redirect") {
        consume();
        redirects.push({
          fd: tok.fd,
          op: tok.op,
          target: tok.target,
          heredocBody: tok.heredocBody,
        });
        continue;
      }

      // Word token
      const word = tok.word;
      if (argv.length === 0 && !word.hasQuotes) {
        const assignMatch = ENV_ASSIGN_RE.exec(word.raw);
        if (assignMatch && assignMatch[1] !== undefined) {
          consume();
          const eqIdx = word.value.indexOf("=");
          const valStr = eqIdx >= 0 ? word.value.slice(eqIdx + 1) : "";
          envAssignments.push({
            name: assignMatch[1],
            value: {
              ...word,
              value: valStr,
            },
          });
          continue;
        }
      }

      consume();
      argv.push(word);
    }

    if (
      envAssignments.length === 0 &&
      argv.length === 0 &&
      redirects.length === 0
    ) {
      return null;
    }

    return {
      kind: "simple",
      envAssignments,
      argv,
      redirects,
    };
  }

  function collectTrailingRedirects(): RedirectNode[] {
    const redirects: RedirectNode[] = [];
    while (pos < len && peek()?.type === "redirect") {
      const tok = consume() as Extract<LexToken, { type: "redirect" }>;
      redirects.push({
        fd: tok.fd,
        op: tok.op,
        target: tok.target,
        heredocBody: tok.heredocBody,
      });
    }
    return redirects;
  }

  return parseProgram();
}

export function formatNormalizedPipelines(pipelines: PipelineNode[]): string {
  const parts: string[] = [];

  for (let i = 0; i < pipelines.length; i++) {
    const p = pipelines[i]!;
    const segStrs = p.segments.map((seg, idx) => {
      const cmdStr = formatCommandNode(seg.command);
      if (idx < p.segments.length - 1 && seg.pipeOp) {
        return `${cmdStr} ${seg.pipeOp}`;
      }
      return cmdStr;
    });
    const line = `${p.negated ? "! " : ""}${segStrs.join(" ")}`;
    if (i < pipelines.length - 1) {
      const term =
        p.terminator && p.terminator !== "\n" ? p.terminator : ";";
      parts.push(term === ";" ? `${line};` : `${line} ${term}`);
    } else {
      parts.push(p.terminator === "&" ? `${line} &` : line);
    }
  }

  return parts.join(" ").trim();
}

function formatCommandNode(node: CommandNode): string {
  if (node.kind === "function") {
    return `${node.name}() ${formatCommandNode(node.body)}`;
  }
  if (node.kind === "subshell" || node.kind === "group") {
    const inner = formatNormalizedPipelines(node.pipelines);
    const redirs = formatRedirects(node.redirects);
    const wrapped =
      node.kind === "subshell" ? `(${inner})` : `{ ${inner}; }`;
    return redirs ? `${wrapped} ${redirs}` : wrapped;
  }
  if (node.kind !== "simple") return "";

  const chunks: string[] = [];
  for (const env of node.envAssignments) {
    chunks.push(`${env.name}=${quoteIfNeeded(env.value.value)}`);
  }
  for (const arg of node.argv) {
    chunks.push(quoteIfNeeded(arg.value));
  }
  const redirs = formatRedirects(node.redirects);
  if (redirs) chunks.push(redirs);
  return chunks.join(" ");
}

function formatRedirects(redirects: RedirectNode[]): string {
  return redirects
    .map((r) => {
      const prefix = r.fd !== undefined ? `${r.fd}` : "";
      return `${prefix}${r.op}${quoteIfNeeded(r.target.value)}`;
    })
    .join(" ");
}

function quoteIfNeeded(val: string): string {
  if (val === "") return '""';
  if (/[\s"'\\$`|&;<>()!*?[\]#~]/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}
