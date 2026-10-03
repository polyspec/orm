// 검증된 check의 정규 텍스트(DbspecCheck.expression)를 술어 트리로 읽는다.
// 모델은 정규 텍스트만 보관하므로, 렌더러는 이 트리에서 피연산자와 열을 찾는다.
// 정규 텍스트가 아닌 입력은 위치를 담은 Error로 거부한다.

type CheckLiteral = { readonly kind: 'literal'; readonly text: string };
export type CheckOperand = { readonly kind: 'column'; readonly name: string } | CheckLiteral;

// 트리는 괄호를 두지 않는다. 출력은 and 안의 or에만 괄호를 쓴다.
export type CheckExpr =
  | { readonly kind: 'logical'; readonly op: 'and' | 'or'; readonly left: CheckExpr; readonly right: CheckExpr }
  | { readonly kind: 'compare'; readonly op: string; readonly left: CheckOperand; readonly right: CheckOperand }
  | { readonly kind: 'in'; readonly operand: CheckOperand; readonly negated: boolean; readonly list: readonly string[] }
  | { readonly kind: 'is_null'; readonly operand: CheckOperand; readonly negated: boolean };

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
  const literal = (): CheckLiteral => {
    const tok = toks[i];
    if (tok === undefined) return fail();
    if (tok.kind === 'string' || (tok.kind === 'word' && (NUMBER.test(tok.text) || tok.text === 'true' || tok.text === 'false'))) {
      i++;
      return { kind: 'literal', text: tok.text };
    }
    return fail();
  };
  const operand = (): CheckOperand => {
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
      return inner;
    }
    const left = operand();
    const next = toks[i];
    if (next !== undefined && next.kind === 'op') {
      i++;
      return { kind: 'compare', op: next.text, left, right: operand() };
    }
    const negated = peekWord('not') && peekWord('in', 1);
    if (negated) i++;
    if (peekWord('in')) {
      i++;
      expect('punct', '(');
      const list: string[] = [];
      for (;;) {
        list.push(literal().text);
        const sep = toks[i];
        if (sep === undefined || sep.kind !== 'punct' || sep.text !== ',') break;
        i++;
      }
      expect('punct', ')');
      return { kind: 'in', operand: left, negated, list };
    }
    if (peekWord('is')) {
      i++;
      const isNot = peekWord('not');
      if (isNot) i++;
      expect('word', 'null');
      return { kind: 'is_null', operand: left, negated: isNot };
    }
    return fail();
  };
  const and = (): CheckExpr => {
    let left = predicate();
    while (peekWord('and')) {
      i++;
      left = { kind: 'logical', op: 'and', left, right: predicate() };
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
