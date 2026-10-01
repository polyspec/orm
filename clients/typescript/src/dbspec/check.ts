// Reads the canonical text of a validated check (DbspecCheck.expression) into a
// predicate tree. The model keeps only the canonical text, so the renderer finds
// operands and columns in this tree. Input that is not canonical text is rejected
// with an Error that gives its position.

export type CheckExpr =
  | { readonly kind: 'column'; readonly name: string }
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'not'; readonly operand: CheckExpr }
  | { readonly kind: 'paren'; readonly inner: CheckExpr }
  | { readonly kind: 'logical'; readonly op: 'and' | 'or'; readonly left: CheckExpr; readonly right: CheckExpr }
  | { readonly kind: 'compare'; readonly op: string; readonly left: CheckExpr; readonly right: CheckExpr }
  | { readonly kind: 'in'; readonly operand: CheckExpr; readonly negated: boolean; readonly list: readonly string[] }
  | {
      readonly kind: 'between';
      readonly operand: CheckExpr;
      readonly negated: boolean;
      readonly low: CheckExpr;
      readonly high: CheckExpr;
    }
  | { readonly kind: 'is_null'; readonly operand: CheckExpr; readonly negated: boolean };

interface Token {
  readonly kind: 'string' | 'punct' | 'op' | 'word';
  readonly text: string;
  readonly at: number;
}

const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'between', 'is', 'null']);
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const COLUMN = /^[a-z][a-z0-9_]*$/;

function tokens(text: string, name: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ') {
      i++;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new Error(`check ${name}: unterminated string at offset ${i}`);
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out.push({ kind: 'string', text: text.slice(i, j + 1), at: i });
      i = j + 1;
    } else if (c === '(' || c === ')' || c === ',') {
      out.push({ kind: 'punct', text: c, at: i });
      i++;
    } else if (c === '<' || c === '>' || c === '=') {
      const two = text.slice(i, i + 2);
      const op = COMPARISONS.has(two) ? two : c;
      out.push({ kind: 'op', text: op, at: i });
      i += op.length;
    } else {
      let j = i;
      while (j < text.length && !" '(),<>=".includes(text[j]!)) j++;
      out.push({ kind: 'word', text: text.slice(i, j), at: i });
      i = j;
    }
  }
  return out;
}

/** Reads the canonical expression text of check `name` into its predicate tree. */
export function readCheck(text: string, name: string): CheckExpr {
  const toks = tokens(text, name);
  let i = 0;
  const fail = (): never => {
    const tok = toks[i];
    throw new Error(`check ${name}: unexpected ${tok === undefined ? 'end of expression' : `${tok.text} at offset ${tok.at}`}`);
  };
  const peekWord = (word: string, ahead = 0): boolean => {
    const tok = toks[i + ahead];
    return tok !== undefined && tok.kind === 'word' && tok.text === word;
  };
  const expect = (kind: Token['kind'], text: string): void => {
    const tok = toks[i];
    if (tok === undefined || tok.kind !== kind || tok.text !== text) fail();
    i++;
  };
  const literal = (): CheckExpr => {
    const tok = toks[i];
    if (tok === undefined) return fail();
    if (tok.kind === 'string' || (tok.kind === 'word' && (NUMBER.test(tok.text) || tok.text === 'true' || tok.text === 'false'))) {
      i++;
      return { kind: 'literal', text: tok.text };
    }
    return fail();
  };
  const operand = (): CheckExpr => {
    const tok = toks[i];
    if (tok !== undefined && tok.kind === 'word' && !KEYWORDS.has(tok.text) && COLUMN.test(tok.text) && tok.text !== 'true' && tok.text !== 'false') {
      i++;
      return { kind: 'column', name: tok.text };
    }
    return literal();
  };
  const predicate = (): CheckExpr => {
    const first = toks[i];
    if (first !== undefined && first.kind === 'punct' && first.text === '(') {
      i++;
      const inner = or();
      expect('punct', ')');
      return { kind: 'paren', inner };
    }
    const left = operand();
    const next = toks[i];
    if (next !== undefined && next.kind === 'op') {
      i++;
      return { kind: 'compare', op: next.text, left, right: operand() };
    }
    const negated = peekWord('not') && (peekWord('in', 1) || peekWord('between', 1));
    if (negated) i++;
    if (peekWord('in')) {
      i++;
      expect('punct', '(');
      const list: string[] = [];
      for (;;) {
        const value = literal();
        if (value.kind !== 'literal') return fail();
        list.push(value.text);
        const sep = toks[i];
        if (sep === undefined || sep.kind !== 'punct' || sep.text !== ',') break;
        i++;
      }
      expect('punct', ')');
      return { kind: 'in', operand: left, negated, list };
    }
    if (peekWord('between')) {
      i++;
      const low = literal();
      expect('word', 'and');
      return { kind: 'between', operand: left, negated, low, high: literal() };
    }
    if (negated) return fail();
    if (peekWord('is')) {
      i++;
      const isNot = peekWord('not');
      if (isNot) i++;
      expect('word', 'null');
      return { kind: 'is_null', operand: left, negated: isNot };
    }
    if (left.kind !== 'column') return fail();
    return left;
  };
  const not = (): CheckExpr => {
    if (peekWord('not')) {
      i++;
      return { kind: 'not', operand: not() };
    }
    return predicate();
  };
  const and = (): CheckExpr => {
    let left = not();
    while (peekWord('and')) {
      i++;
      left = { kind: 'logical', op: 'and', left, right: not() };
    }
    return left;
  };
  const or = (): CheckExpr => {
    let left = and();
    while (peekWord('or')) {
      i++;
      left = { kind: 'logical', op: 'or', left, right: and() };
    }
    return left;
  };
  const tree = or();
  if (i < toks.length) fail();
  return tree;
}
