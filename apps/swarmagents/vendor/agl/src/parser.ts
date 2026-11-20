import { createHash } from 'node:crypto';
import { Token, Lexer } from './lexer.ts';

export type ASTNodeType =
  | 'EXPRESSION'
  | 'LITERAL'
  | 'VARIABLE'
  | 'HASH_REFERENCE';

export interface ASTNode {
  type: ASTNodeType;
  level?: number;
  op?: string;
  args?: ASTNode[];
  value?: string | number | boolean;
  hash: string; // Content-addressed SHA-256 fingerprint
}

export class Parser {
  private tokens: Token[] = [];
  private current = 0;

  constructor(inputOrTokens: string | Token[]) {
    if (typeof inputOrTokens === 'string') {
      const lexer = new Lexer(inputOrTokens);
      this.tokens = lexer.tokenize();
    } else {
      this.tokens = inputOrTokens;
    }
  }

  public parse(): ASTNode {
    const expr = this.parseExpression();
    return expr;
  }

  public parseAll(): ASTNode[] {
    const expressions: ASTNode[] = [];
    while (!this.isAtEnd() && this.peek().type !== 'EOF') {
      expressions.push(this.parseExpression());
    }
    return expressions;
  }

  private parseExpression(): ASTNode {
    const tok = this.peek();

    if (tok.type === 'LPAREN') {
      this.advance(); // consume '('
      const head = this.peek();
      
      let level: number | undefined;
      let op: string | undefined;

      if (head.type === 'LEVEL_OP') {
        const opToken = this.advance();
        level = opToken.level;
        op = opToken.opName;
      } else if (head.type === 'SYMBOL') {
        const symToken = this.advance();
        op = String(symToken.value);
        level = 0; // Default level 0 if bare symbol
      } else {
        throw new Error(`Syntax Error at line ${head.line}, col ${head.col}: Expected Operator after '('`);
      }

      const args: ASTNode[] = [];
      while (this.peek().type !== 'RPAREN' && !this.isAtEnd()) {
        args.push(this.parseExpression());
      }

      if (this.peek().type !== 'RPAREN') {
        throw new Error(`Syntax Error: Unclosed parenthesis at end of expression.`);
      }
      this.advance(); // consume ')'

      // Compute content hash
      const contentRepr = `(lvl:${level}:${op} ${args.map(a => a.hash).join(' ')})`;
      const hash = createHash('sha256').update(contentRepr).digest('hex');

      return {
        type: 'EXPRESSION',
        level,
        op,
        args,
        hash
      };
    }

    // Literals & symbols
    if (tok.type === 'NUMBER' || tok.type === 'STRING' || tok.type === 'BOOLEAN') {
      const lit = this.advance();
      const hash = createHash('sha256').update(`${tok.type}:${lit.value}`).digest('hex');
      return {
        type: 'LITERAL',
        value: lit.value,
        hash
      };
    }

    if (tok.type === 'SYMBOL') {
      const sym = this.advance();
      const val = String(sym.value);
      if (val.startsWith('sha256:')) {
        return {
          type: 'HASH_REFERENCE',
          value: val,
          hash: val.replace('sha256:', '')
        };
      }
      const hash = createHash('sha256').update(`VAR:${val}`).digest('hex');
      return {
        type: 'VARIABLE',
        value: val,
        hash
      };
    }

    throw new Error(`Unexpected token ${tok.type} (${tok.value}) at line ${tok.line}:${tok.col}`);
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.tokens[this.current - 1];
  }

  private isAtEnd(): boolean {
    return this.current >= this.tokens.length || this.tokens[this.current].type === 'EOF';
  }
}
