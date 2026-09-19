/**
 * Tokenizer for the Python subset used by Odoo view attributes, domains,
 * contexts and defaults.
 *
 * Covers: int/float literals, single- and double-quoted strings (with escapes
 * and adjacent-literal concatenation handled by the parser), identifiers and
 * keywords, all operators/delimiters Odoo uses, and comments (`#`).
 */

export type TokenType =
  | 'number'
  | 'string'
  | 'name'
  | 'keyword'
  | 'op'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw source text for ops/names/keywords; decoded value for literals. */
  value: string;
  /** Parsed value for `number` and `string` tokens. */
  literal?: number | string;
  start: number;
  end: number;
}

export class ExprSyntaxError extends Error {
  readonly source: string;
  readonly position: number;

  constructor(message: string, source: string, position: number) {
    super(`${message} (at ${position} in ${JSON.stringify(source)})`);
    this.name = 'ExprSyntaxError';
    this.source = source;
    this.position = position;
  }
}

const KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'is', 'if', 'else',
  'True', 'False', 'None',
  'for', 'lambda',
]);

/**
 * Multi-character operators, longest first so the scanner never splits `**`
 * into two `*` or `<=` into `<` and `=`.
 */
const OPERATORS = [
  '**', '//', '==', '!=', '<=', '>=', '<>',
  '+', '-', '*', '/', '%', '<', '>', '=',
  '(', ')', '[', ']', '{', '}', ',', ':', '.', '|', '&', '~', '^',
];

const DIGIT = /[0-9]/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function decodeEscape(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '\0';
    case '\\': return '\\';
    case "'": return "'";
    case '"': return '"';
    default: return ch;
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    // Whitespace (including newlines: Odoo domains are often multi-line).
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i += 1;
      continue;
    }

    // Comments run to end of line.
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    // Strings. Python string prefixes (r, b, u, f) are accepted and ignored
    // except that `r` suppresses escape decoding.
    let prefix = '';
    let prefixLen = 0;
    if (IDENT_START.test(ch)) {
      const maybe = source.slice(i, i + 2).toLowerCase();
      if ((maybe[0] === 'r' || maybe[0] === 'b' || maybe[0] === 'u' || maybe[0] === 'f')
        && (maybe[1] === "'" || maybe[1] === '"')) {
        prefix = maybe[0];
        prefixLen = 1;
      }
    }
    const quoteChar = source[i + prefixLen];
    if (quoteChar === "'" || quoteChar === '"') {
      const start = i;
      let j = i + prefixLen + 1;
      // Triple-quoted strings.
      const triple = source.slice(j - 1, j + 2) === quoteChar.repeat(3);
      if (triple) j += 2;
      const closing = triple ? quoteChar.repeat(3) : quoteChar;
      let out = '';
      let closed = false;
      while (j < n) {
        if (!triple && source[j] === '\\' && prefix !== 'r') {
          j += 1;
          if (j >= n) break;
          out += decodeEscape(source[j]);
          j += 1;
          continue;
        }
        if (source.startsWith(closing, j)) {
          j += closing.length;
          closed = true;
          break;
        }
        out += source[j];
        j += 1;
      }
      if (!closed) throw new ExprSyntaxError('Unterminated string literal', source, start);
      tokens.push({ type: 'string', value: source.slice(start, j), literal: out, start, end: j });
      i = j;
      continue;
    }

    // Numbers. Python allows `1_000`, `.5`, `1.`, `1e-3`, `0x1f`.
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(source[i + 1] ?? ''))) {
      const start = i;
      let j = i;
      if (ch === '0' && (source[j + 1] === 'x' || source[j + 1] === 'X')) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(source[j])) j += 1;
        const raw = source.slice(start, j).replace(/_/g, '');
        tokens.push({ type: 'number', value: raw, literal: Number(raw), start, end: j });
        i = j;
        continue;
      }
      let seenDot = false;
      let seenExp = false;
      while (j < n) {
        const c = source[j];
        if (DIGIT.test(c) || c === '_') { j += 1; continue; }
        if (c === '.' && !seenDot && !seenExp) { seenDot = true; j += 1; continue; }
        if ((c === 'e' || c === 'E') && !seenExp && DIGIT.test(source[j + 1] ?? (source[j + 1] === '-' || source[j + 1] === '+' ? '0' : ''))) {
          seenExp = true; j += 1; continue;
        }
        if ((c === 'e' || c === 'E') && !seenExp && (source[j + 1] === '-' || source[j + 1] === '+') && DIGIT.test(source[j + 2] ?? '')) {
          seenExp = true; j += 2; continue;
        }
        break;
      }
      const raw = source.slice(start, j).replace(/_/g, '');
      tokens.push({ type: 'number', value: raw, literal: Number(raw), start, end: j });
      i = j;
      continue;
    }

    // Identifiers and keywords.
    if (IDENT_START.test(ch)) {
      const start = i;
      let j = i;
      while (j < n && IDENT_PART.test(source[j])) j += 1;
      const word = source.slice(start, j);
      tokens.push({
        type: KEYWORDS.has(word) ? 'keyword' : 'name',
        value: word,
        start,
        end: j,
      });
      i = j;
      continue;
    }

    // Operators and delimiters.
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: 'op', value: op === '<>' ? '!=' : op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }

    throw new ExprSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, source, i);
  }

  tokens.push({ type: 'eof', value: '', start: n, end: n });
  return tokens;
}
