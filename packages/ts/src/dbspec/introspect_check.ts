// dialect catalog의 check 식을 dbspec predicate text로 읽는다
// (docs/dialects.md "Introspection", "Checks").
import { quote } from './introspect_catalog.js';
import type { DbspecType } from './model.js';
import type { DbspecDialect } from './render.js';

/** check 식을 dbspec predicate로 읽을 수 없다는 error다. 그 check은 미지원으로 보고된다. */
export class CheckDecodeError extends Error {
  override name = 'CheckDecodeError';
}

/**
 * check 식을 dbspec predicate text로 읽는다. columns는 table의 column type이며,
 * literal은 그것이 만나는 column의 값으로 읽는다. 읽을 수 없는 식은 CheckDecodeError다.
 */
export function decodeCheck(dialect: DbspecDialect, text: string, columns: ReadonlyMap<string, DbspecType>): string {
  if (dialect === 'mysql') text = unescapeMySQLClause(text);
  if (dialect === 'postgres') {
    if (!text.startsWith('CHECK ')) throw new CheckDecodeError(`constraint definition ${JSON.stringify(text)} does not start with CHECK`);
    text = text.slice('CHECK '.length);
  }
  const d = new CheckDecoder(checkTokens(dialect, text), columns, dialect);
  const node = d.expression();
  if (d.i !== d.tokens.length) throw new CheckDecodeError(`unexpected ${JSON.stringify(d.tokens[d.i]!.text)}`);
  if (node.kind === 'operand') throw new CheckDecodeError('an operand alone is not a predicate');
  return d.write(node);
}

/** CHECK_CLAUSE가 문자열 literal에 더한 두 번째 escape를 푼다: `\\`는 `\`, `\'`는 `'`가 된다. */
function unescapeMySQLClause(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && (text[i + 1] === '\\' || text[i + 1] === "'")) {
      out += text[i + 1];
      i++;
      continue;
    }
    out += text[i];
  }
  return out;
}

type TokenKind = 'ident' | 'word' | 'number' | 'string' | 'op' | 'punct' | '';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const END: Token = { kind: '', text: '' };

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

function checkTokens(dialect: DbspecDialect, text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === ' ') {
      i++;
    } else if (ch === '`' || ch === '"') {
      const j = text.indexOf(ch, i + 1);
      if (j < 0) throw new CheckDecodeError('unclosed identifier');
      out.push({ kind: 'ident', text: text.slice(i + 1, j) });
      i = j + 1;
    } else if (ch === "'") {
      const [value, n] = readSQLString(dialect, text.slice(i));
      out.push({ kind: 'string', text: value });
      i += n;
    } else if (isDigit(ch)) {
      let j = i;
      while (j < text.length && (isDigit(text[j]!) || text[j] === '.')) j++;
      out.push({ kind: 'number', text: text.slice(i, j) });
      i = j;
    } else if (ch === '_' || isLetter(ch)) {
      let j = i;
      while (j < text.length && (text[j] === '_' || isLetter(text[j]!) || isDigit(text[j]!))) j++;
      const word = text.slice(i, j);
      // MySQL 문자열 앞의 character set introducer는 값이 아니다.
      if (dialect === 'mysql' && word.startsWith('_') && text[j] === "'") {
        i = j;
        continue;
      }
      out.push({ kind: 'word', text: word });
      i = j;
    } else if (text.startsWith('::', i)) {
      out.push({ kind: 'op', text: '::' });
      i += 2;
    } else if (text.startsWith('<>', i) || text.startsWith('<=', i) || text.startsWith('>=', i)) {
      out.push({ kind: 'op', text: text.slice(i, i + 2) });
      i += 2;
    } else if (ch === '=' || ch === '<' || ch === '>' || ch === '-') {
      out.push({ kind: 'op', text: ch });
      i++;
    } else if (ch === '(' || ch === ')' || ch === ',' || ch === '[' || ch === ']') {
      out.push({ kind: 'punct', text: ch });
      i++;
    } else {
      throw new CheckDecodeError(`unexpected character ${JSON.stringify(ch)}`);
    }
  }
  return out;
}

/**
 * text 앞의 문자열 literal을 읽어 값과 길이를 돌려준다. PostgreSQL과 SQLite는
 * ''만 escape이고, MySQL은 backslash escape도 쓴다.
 */
function readSQLString(dialect: DbspecDialect, text: string): [string, number] {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" && i + 1 < text.length && text[i + 1] === "'") {
      out += "'";
      i++;
    } else if (ch === "'") {
      return [out, i + 1];
    } else if (ch === '\\' && dialect === 'mysql' && i + 1 < text.length) {
      i++;
      out += MYSQL_ESCAPES[text[i]!] ?? text[i];
    } else {
      out += ch;
    }
  }
  throw new CheckDecodeError('unclosed string literal');
}

const MYSQL_ESCAPES: Readonly<Record<string, string>> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

/** column이나 literal이다. */
interface Operand {
  readonly kind: 'operand';
  readonly type: 'column' | 'number' | 'string' | 'bool';
  readonly text: string;
}

/** 비교, in, is null, and, or다. */
type Predicate =
  | { readonly kind: 'and' | 'or'; readonly left: Node; readonly right: Node }
  | { readonly kind: 'compare'; readonly left: Operand; readonly right: Operand; readonly operator: string }
  | { readonly kind: 'in'; readonly left: Operand; readonly list: Operand[]; readonly negated: boolean }
  | { readonly kind: 'null'; readonly left: Operand; readonly negated: boolean };

type Node = Operand | Predicate;

const operand = (type: Operand['type'], text: string): Operand => ({ kind: 'operand', type, text });

const COMPARISONS: ReadonlySet<string> = new Set(['=', '<>', '<', '<=', '>', '>=']);
const CAST_STOP_WORDS: ReadonlySet<string> = new Set(['and', 'or', 'is', 'not', 'in']);
const NUMERIC_CASTS: ReadonlySet<string> = new Set(['smallint', 'integer', 'bigint', 'numeric', 'double precision', 'real']);

class CheckDecoder {
  i = 0;

  constructor(
    readonly tokens: readonly Token[],
    private readonly columns: ReadonlyMap<string, DbspecType>,
    private readonly dialect: DbspecDialect,
  ) {}

  private peek(): Token {
    return this.tokens[this.i] ?? END;
  }

  private word(text: string): boolean {
    const t = this.peek();
    if (t.kind === 'word' && t.text.toLowerCase() === text) {
      this.i++;
      return true;
    }
    return false;
  }

  private punct(text: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === text) {
      this.i++;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.punct(text)) throw new CheckDecodeError(`expected ${JSON.stringify(text)} at token ${this.i}`);
  }

  expression(): Node {
    let left = this.and();
    while (this.word('or')) left = { kind: 'or', left, right: this.and() };
    return left;
  }

  private and(): Node {
    let left = this.predicate();
    while (this.word('and')) left = { kind: 'and', left, right: this.predicate() };
    return left;
  }

  /** 괄호로 묶인 식이나 operand로 시작하는 predicate 하나를 읽는다. */
  private predicate(): Node {
    const left = this.term();
    if (left.kind !== 'operand') return left;
    const t = this.peek();
    if (t.kind === 'op' && COMPARISONS.has(t.text)) {
      this.i++;
      if (this.word('any') || this.word('all')) {
        const list = this.array();
        if (t.text === '=') return { kind: 'in', left, list, negated: false };
        if (t.text === '<>') return { kind: 'in', left, list, negated: true };
        throw new CheckDecodeError(`${t.text} with ANY or ALL`);
      }
      const right = this.term();
      if (right.kind !== 'operand') throw new CheckDecodeError('a comparison with a predicate');
      return { kind: 'compare', left, right, operator: t.text };
    }
    if (this.word('is')) {
      const negated = this.word('not');
      if (!this.word('null')) throw new CheckDecodeError('expected null after is');
      return { kind: 'null', left, negated };
    }
    if (this.word('not')) {
      if (!this.word('in')) throw new CheckDecodeError('not outside not in');
      return { kind: 'in', left, list: this.list(), negated: true };
    }
    if (this.word('in')) return { kind: 'in', left, list: this.list(), negated: false };
    return left;
  }

  /** 괄호 식이나 operand와 그 뒤의 cast를 읽는다. 괄호 안이 operand 하나면 operand다. */
  private term(): Node {
    let node: Node;
    if (this.punct('(')) {
      node = this.expression();
      this.expect(')');
    } else {
      node = this.operand();
    }
    while (this.peek().kind === 'op' && this.peek().text === '::') {
      this.i++;
      const typeName = this.castType();
      if (node.kind !== 'operand') throw new CheckDecodeError('a cast of a predicate');
      if (node.type === 'string' && NUMERIC_CASTS.has(typeName)) node = operand('number', node.text);
    }
    return node;
  }

  /** `::` 뒤의 type 이름을 읽는다: 단어들과 (n), []. */
  private castType(): string {
    const words: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === 'word' && !CAST_STOP_WORDS.has(t.text.toLowerCase())) {
        words.push(t.text);
        this.i++;
      } else if (t.kind === 'punct' && t.text === '[' && this.tokens[this.i + 1]?.text === ']') {
        this.i += 2;
      } else {
        return words.join(' ');
      }
    }
  }

  private operand(): Operand {
    const t = this.peek();
    if (t.kind === 'ident') {
      this.i++;
      return operand('column', t.text);
    }
    if (t.kind === 'number') {
      this.i++;
      return operand('number', t.text);
    }
    if (t.kind === 'string') {
      this.i++;
      return operand('string', t.text);
    }
    if (t.kind === 'op' && t.text === '-') {
      this.i++;
      if (this.punct('(')) {
        const n = this.peek();
        if (n.kind !== 'number') throw new CheckDecodeError('expected a number after -(');
        this.i++;
        this.expect(')');
        return operand('number', '-' + n.text);
      }
      const n = this.peek();
      if (n.kind !== 'number') throw new CheckDecodeError('expected a number after -');
      this.i++;
      return operand('number', '-' + n.text);
    }
    if (t.kind === 'word' && (t.text.toLowerCase() === 'true' || t.text.toLowerCase() === 'false')) {
      this.i++;
      return operand('bool', t.text.toLowerCase());
    }
    if (t.kind === 'word') {
      this.i++;
      return operand('column', t.text);
    }
    throw new CheckDecodeError(`unexpected ${JSON.stringify(t.text)}`);
  }

  /** in 뒤의 (a, b, ...)를 읽는다. */
  private list(): Operand[] {
    this.expect('(');
    const out: Operand[] = [];
    for (;;) {
      const node = this.term();
      if (node.kind !== 'operand' || node.type === 'column') throw new CheckDecodeError('an in list holds literals only');
      out.push(node);
      if (this.punct(')')) return out;
      this.expect(',');
    }
  }

  /** PostgreSQL의 ANY나 ALL 뒤의 (ARRAY[...]) 또는 ((ARRAY[...])::type[])를 읽는다. */
  private array(): Operand[] {
    this.expect('(');
    const wrapped = this.punct('(');
    if (!this.word('array')) throw new CheckDecodeError('expected ARRAY');
    this.expect('[');
    const out: Operand[] = [];
    for (;;) {
      const node = this.term();
      if (node.kind !== 'operand' || node.type === 'column') throw new CheckDecodeError('an array holds literals only');
      out.push(node);
      if (this.punct(']')) break;
      this.expect(',');
    }
    if (wrapped) {
      this.expect(')');
      if (this.peek().text === '::') {
        this.i++;
        this.castType();
      }
    }
    this.expect(')');
    return out;
  }

  /** predicate를 dbspec text로 쓴다. 괄호는 필요한 곳보다 많아도 되며 canonical form은 parse가 정한다. */
  write(p: Predicate): string {
    switch (p.kind) {
      case 'and':
      case 'or':
        return `(${this.side(p.left)} ${p.kind} ${this.side(p.right)})`;
      case 'compare': {
        const type = this.typeOf(p.left, p.right);
        return `${this.operandText(p.left, type)} ${p.operator} ${this.operandText(p.right, type)}`;
      }
      case 'in': {
        const type = this.typeOf(p.left, null);
        const items = p.list.map(item => this.operandText(item, type));
        return `${this.operandText(p.left, type)}${p.negated ? ' not in (' : ' in ('}${items.join(', ')})`;
      }
      case 'null':
        return `${this.operandText(p.left, null)}${p.negated ? ' is not null' : ' is null'}`;
    }
  }

  private side(n: Node): string {
    if (n.kind === 'operand') throw new CheckDecodeError('an operand alone is not a predicate');
    return this.write(n);
  }

  private typeOf(a: Operand, b: Operand | null): DbspecType | null {
    for (const o of [a, b]) {
      if (o !== null && o.type === 'column') return this.columns.get(o.text) ?? null;
    }
    return null;
  }

  /** operand를 dbspec 표기로 쓴다. bool column의 1과 0은 true와 false, SQLite decimal의 정수는 scale을 나눈 값이다. */
  private operandText(o: Operand, type: DbspecType | null): string {
    switch (o.type) {
      case 'column':
        if (!this.columns.has(o.text)) throw new CheckDecodeError(`unknown column ${o.text}`);
        return o.text;
      case 'string':
        return quote(o.text);
      case 'bool':
        return o.text;
      case 'number':
        if (type?.kind === 'bool' && o.text === '1') return 'true';
        if (type?.kind === 'bool' && o.text === '0') return 'false';
        if (type?.kind === 'decimal' && this.dialect === 'sqlite') return unscaledDecimal(o.text, type.scale);
        return o.text;
    }
  }
}

/** 10^scale을 곱한 정수 text를 scale 자리 소수로 쓴다. */
export function unscaledDecimal(text: string, scale: number): string {
  const negative = text.startsWith('-');
  let digits = negative ? text.slice(1) : text;
  if (scale > 0) {
    if (digits.length <= scale) digits = '0'.repeat(scale - digits.length + 1) + digits;
    digits = digits.slice(0, digits.length - scale) + '.' + digits.slice(digits.length - scale);
  }
  return negative ? '-' + digits : digits;
}
