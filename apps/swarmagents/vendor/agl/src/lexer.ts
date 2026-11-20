export type TokenType =
  | 'LPAREN'
  | 'RPAREN'
  | 'LEVEL_OP'    // e.g. lvl:0:add, lvl:1:modify, lvl:2:pipeline
  | 'SYMBOL'      // identifier or bare keyword
  | 'STRING'      // "quoted"
  | 'NUMBER'      // 123, -45.6
  | 'BOOLEAN'     // true, false
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string | number | boolean;
  level?: number;
  opName?: string;
  line: number;
  col: number;
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(private readonly input: string) {}

  public tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      // Whitespace
      if (/\s/.test(ch)) {
        if (ch === '\n') {
          this.line++;
          this.col = 1;
        } else {
          this.col++;
        }
        this.pos++;
        continue;
      }

      // Comments: ;; or //
      if ((ch === ';' && this.peek() === ';') || (ch === '/' && this.peek() === '/')) {
        while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
          this.pos++;
        }
        continue;
      }

      if (ch === '(') {
        tokens.push({ type: 'LPAREN', value: '(', line: this.line, col: this.col });
        this.advance();
        continue;
      }
      if (ch === ')') {
        tokens.push({ type: 'RPAREN', value: ')', line: this.line, col: this.col });
        this.advance();
        continue;
      }

      // Strings
      if (ch === '"' || ch === "'") {
        tokens.push(this.readString(ch));
        continue;
      }

      // Numbers or negative numbers
      if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(this.peek() || ''))) {
        tokens.push(this.readNumber());
        continue;
      }

      // Symbols, Level prefixes, or Booleans
      tokens.push(this.readSymbolOrLevel());
    }

    tokens.push({ type: 'EOF', value: '', line: this.line, col: this.col });
    return tokens;
  }

  private peek(): string | null {
    return this.pos + 1 < this.input.length ? this.input[this.pos + 1] : null;
  }

  private advance(): string {
    const ch = this.input[this.pos++];
    this.col++;
    return ch;
  }

  private readString(quote: string): Token {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // skip quote
    let str = '';
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === '\\') {
        this.advance();
        const esc = this.advance();
        if (esc === 'n') str += '\n';
        else if (esc === 't') str += '\t';
        else if (esc === 'r') str += '\r';
        else str += esc;
        continue;
      }
      if (ch === quote) {
        this.advance();
        break;
      }
      str += this.advance();
    }
    return { type: 'STRING', value: str, line: startLine, col: startCol };
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let raw = '';
    if (this.input[this.pos] === '-') {
      raw += this.advance();
    }
    while (this.pos < this.input.length && /[0-9.]/.test(this.input[this.pos])) {
      raw += this.advance();
    }
    const num = Number(raw);
    return { type: 'NUMBER', value: num, line: startLine, col: startCol };
  }

  private readSymbolOrLevel(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let raw = '';
    while (
      this.pos < this.input.length &&
      !/[\s()";]/.test(this.input[this.pos])
    ) {
      raw += this.advance();
    }

    // Check level prefix: lvl:<N>:<opName>
    const levelMatch = raw.match(/^lvl:([0-9]+):([a-zA-Z0-9_]+)$/);
    if (levelMatch) {
      return {
        type: 'LEVEL_OP',
        value: raw,
        level: parseInt(levelMatch[1], 10),
        opName: levelMatch[2],
        line: startLine,
        col: startCol
      };
    }

    if (raw === 'true') {
      return { type: 'BOOLEAN', value: true, line: startLine, col: startCol };
    }
    if (raw === 'false') {
      return { type: 'BOOLEAN', value: false, line: startLine, col: startCol };
    }

    return { type: 'SYMBOL', value: raw, line: startLine, col: startCol };
  }
}
