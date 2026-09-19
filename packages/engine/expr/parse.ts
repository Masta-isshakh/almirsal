import { ExprSyntaxError, tokenize, type Token } from './tokenize.js';
import type {
  BinOperator,
  CompareOperator,
  KeywordArg,
  Node,
  UnaryOperator,
} from './ast.js';

/**
 * Recursive-descent parser for the Python subset.
 *
 * Precedence, lowest to highest:
 *   ternary (`a if c else b`) < or < and < not < comparison
 *   < `|` < `^` < `&` < `+ -` < `* / // %` < unary < `**` < postfix < atom
 *
 * `**` is right-associative and binds tighter than a leading unary minus
 * (`-2**2 == -4`), exactly as in Python.
 */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private at(value: string, type?: 'op' | 'keyword'): boolean {
    const token = this.peek();
    if (type && token.type !== type) return false;
    if (!type && token.type !== 'op' && token.type !== 'keyword') return false;
    return token.value === value;
  }

  private accept(value: string, type?: 'op' | 'keyword'): boolean {
    if (this.at(value, type)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(value: string, type?: 'op' | 'keyword'): Token {
    if (!this.at(value, type)) {
      const token = this.peek();
      throw new ExprSyntaxError(
        `Expected ${JSON.stringify(value)} but found ${JSON.stringify(token.value || '<eof>')}`,
        this.source,
        token.start,
      );
    }
    return this.next();
  }

  private fail(token: Token): never {
    throw new ExprSyntaxError(
      `Unexpected token ${JSON.stringify(token.value || '<eof>')}`,
      this.source,
      token.start,
    );
  }

  parseProgram(): Node {
    const node = this.parseExpressionList();
    const token = this.peek();
    if (token.type !== 'eof') this.fail(token);
    return node;
  }

  /**
   * Top level allows a bare tuple (`1, 2`), which Odoo uses in contexts and
   * in domain leaves written without parentheses.
   */
  private parseExpressionList(): Node {
    const first = this.parseExpression();
    if (!this.at(',', 'op')) return first;
    const elements = [first];
    while (this.accept(',', 'op')) {
      if (this.isExpressionEnd()) break;
      elements.push(this.parseExpression());
    }
    return { type: 'Tuple', elements };
  }

  private isExpressionEnd(): boolean {
    const token = this.peek();
    if (token.type === 'eof') return true;
    return token.type === 'op' && [')', ']', '}'].includes(token.value);
  }

  parseExpression(): Node {
    return this.parseTernary();
  }

  private parseTernary(): Node {
    const body = this.parseOr();
    if (this.at('if', 'keyword')) {
      this.next();
      const test = this.parseOr();
      this.expect('else', 'keyword');
      const orelse = this.parseTernary();
      return { type: 'IfExp', body, test, orelse };
    }
    return body;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    if (!this.at('or', 'keyword')) return left;
    const values = [left];
    while (this.accept('or', 'keyword')) values.push(this.parseAnd());
    return { type: 'BoolOp', op: 'or', values };
  }

  private parseAnd(): Node {
    const left = this.parseNot();
    if (!this.at('and', 'keyword')) return left;
    const values = [left];
    while (this.accept('and', 'keyword')) values.push(this.parseNot());
    return { type: 'BoolOp', op: 'and', values };
  }

  private parseNot(): Node {
    if (this.accept('not', 'keyword')) {
      return { type: 'UnaryOp', op: 'not', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parseBitOr();
    const ops: CompareOperator[] = [];
    const comparators: Node[] = [];

    for (;;) {
      const op = this.matchComparisonOperator();
      if (!op) break;
      ops.push(op);
      comparators.push(this.parseBitOr());
    }

    if (ops.length === 0) return left;
    return { type: 'Compare', left, ops, comparators };
  }

  private matchComparisonOperator(): CompareOperator | null {
    const token = this.peek();
    if (token.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      this.next();
      return token.value as CompareOperator;
    }
    if (token.type === 'keyword' && token.value === 'in') {
      this.next();
      return 'in';
    }
    if (token.type === 'keyword' && token.value === 'not' && this.peek(1).value === 'in') {
      this.next();
      this.next();
      return 'not in';
    }
    if (token.type === 'keyword' && token.value === 'is') {
      this.next();
      if (this.accept('not', 'keyword')) return 'is not';
      return 'is';
    }
    return null;
  }

  private parseBinaryLevel(
    operators: string[],
    nextLevel: () => Node,
  ): Node {
    let left = nextLevel();
    for (;;) {
      const token = this.peek();
      if (token.type !== 'op' || !operators.includes(token.value)) break;
      // `|`, `&` and `^` are also domain connectors in some contexts, but at
      // expression level they are ordinary binary operators.
      this.next();
      const right = nextLevel();
      left = { type: 'BinOp', op: token.value as BinOperator, left, right };
    }
    return left;
  }

  private parseBitOr(): Node {
    return this.parseBinaryLevel(['|'], () => this.parseBitXor());
  }

  private parseBitXor(): Node {
    return this.parseBinaryLevel(['^'], () => this.parseBitAnd());
  }

  private parseBitAnd(): Node {
    return this.parseBinaryLevel(['&'], () => this.parseAdditive());
  }

  private parseAdditive(): Node {
    return this.parseBinaryLevel(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Node {
    return this.parseBinaryLevel(['*', '/', '//', '%'], () => this.parseUnary());
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.type === 'op' && ['-', '+', '~'].includes(token.value)) {
      this.next();
      return { type: 'UnaryOp', op: token.value as UnaryOperator, operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePostfix();
    if (this.at('**', 'op')) {
      this.next();
      // Right-associative, and the exponent may itself be unary-negated.
      const exponent = this.parseUnary();
      return { type: 'BinOp', op: '**', left: base, right: exponent };
    }
    return base;
  }

  private parsePostfix(): Node {
    let node = this.parseAtom();
    for (;;) {
      if (this.at('.', 'op')) {
        this.next();
        const nameToken = this.next();
        if (nameToken.type !== 'name' && nameToken.type !== 'keyword') this.fail(nameToken);
        node = { type: 'Attribute', value: node, attr: nameToken.value };
        continue;
      }
      if (this.at('(', 'op')) {
        this.next();
        const { args, keywords } = this.parseCallArguments();
        node = { type: 'Call', func: node, args, keywords };
        continue;
      }
      if (this.at('[', 'op')) {
        this.next();
        const index = this.parseExpressionList();
        this.expect(']', 'op');
        node = { type: 'Subscript', value: node, index };
        continue;
      }
      break;
    }
    return node;
  }

  private parseCallArguments(): { args: Node[]; keywords: KeywordArg[] } {
    const args: Node[] = [];
    const keywords: KeywordArg[] = [];
    while (!this.at(')', 'op')) {
      // Keyword argument: `name=value`, but not `name == value`.
      const token = this.peek();
      const after = this.peek(1);
      if (token.type === 'name' && after.type === 'op' && after.value === '=') {
        this.next();
        this.next();
        keywords.push({ name: token.value, value: this.parseExpression() });
      } else {
        args.push(this.parseExpression());
      }
      if (!this.accept(',', 'op')) break;
    }
    this.expect(')', 'op');
    return { args, keywords };
  }

  private parseAtom(): Node {
    const token = this.peek();

    if (token.type === 'number') {
      this.next();
      return { type: 'Num', value: token.literal as number };
    }

    if (token.type === 'string') {
      this.next();
      // Python concatenates adjacent string literals: 'a' 'b' === 'ab'.
      let value = token.literal as string;
      while (this.peek().type === 'string') {
        value += this.next().literal as string;
      }
      return { type: 'Str', value };
    }

    if (token.type === 'keyword') {
      if (token.value === 'True') { this.next(); return { type: 'Const', value: true }; }
      if (token.value === 'False') { this.next(); return { type: 'Const', value: false }; }
      if (token.value === 'None') { this.next(); return { type: 'Const', value: null }; }
      if (token.value === 'not') return this.parseNot();
      this.fail(token);
    }

    if (token.type === 'name') {
      this.next();
      return { type: 'Name', id: token.value };
    }

    if (token.type === 'op') {
      if (token.value === '(') {
        this.next();
        if (this.accept(')', 'op')) return { type: 'Tuple', elements: [] };
        const inner = this.parseExpression();
        if (this.at(',', 'op')) {
          const elements = [inner];
          while (this.accept(',', 'op')) {
            if (this.at(')', 'op')) break;
            elements.push(this.parseExpression());
          }
          this.expect(')', 'op');
          return { type: 'Tuple', elements };
        }
        this.expect(')', 'op');
        return inner;
      }

      if (token.value === '[') {
        this.next();
        const elements: Node[] = [];
        while (!this.at(']', 'op')) {
          elements.push(this.parseExpression());
          if (!this.accept(',', 'op')) break;
        }
        this.expect(']', 'op');
        return { type: 'List', elements };
      }

      if (token.value === '{') {
        this.next();
        const keys: Node[] = [];
        const values: Node[] = [];
        const setElements: Node[] = [];
        let isDict: boolean | null = null;
        while (!this.at('}', 'op')) {
          const first = this.parseExpression();
          if (this.accept(':', 'op')) {
            if (isDict === false) this.fail(this.peek());
            isDict = true;
            keys.push(first);
            values.push(this.parseExpression());
          } else {
            if (isDict === true) this.fail(this.peek());
            isDict = false;
            setElements.push(first);
          }
          if (!this.accept(',', 'op')) break;
        }
        this.expect('}', 'op');
        if (isDict === false) return { type: 'Set', elements: setElements };
        return { type: 'Dict', keys, values };
      }
    }

    this.fail(token);
  }
}

const parseCache = new Map<string, Node>();
const CACHE_LIMIT = 5000;

/** Parse an expression source string into an AST (memoised). */
export function parse(source: string): Node {
  const cached = parseCache.get(source);
  if (cached) return cached;
  const node = new Parser(source).parseProgram();
  if (parseCache.size >= CACHE_LIMIT) parseCache.clear();
  parseCache.set(source, node);
  return node;
}

export { ExprSyntaxError };
