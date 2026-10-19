// Comment lexer for the families that have no tokenizer in their ecosystem's toolchain: Rust, C and the hash-comment
// files (shell, Makefile, TOML, INI, YAML, m4). Each family has a rebuild record under docs/rebuild/ that states why no
// tool fits (S1 of PRINCIPLES.md). The lexer skips strings, so Hangul inside a literal is not a comment.

// The lexical rules of one family.
export interface Syntax {
  lineComments: string[];
  blockComment: boolean;
  nestedBlock: boolean;
  // Single-quoted literals: rune or char literals (C, Rust) take an escape-aware single character.
  charLiteral: RegExp;
  // Double-quoted literals; Rust strings may span lines.
  doubleString: RegExp;
  // Raw strings in Rust: r"..." and r#"..."#.
  rawStrings: boolean;
}

export interface OwnComment {
  line: number;
  // col is the offset in the line where text starts; a continuation line of a block comment starts at 0.
  col: number;
  text: string;
}

const C_STRING = /^"(?:\\[\s\S]|[^\\"\n])*"/;
const C_CHAR = /^'(?:\\.[^'\n]*|[^\\'\n])'/;
const JS_STRING = /^'(?:\\.|[^\\'\n])*'/;

export const RUST: Syntax = {
  lineComments: ['//'], blockComment: true, nestedBlock: true, charLiteral: C_CHAR,
  doubleString: /^"(?:\\[\s\S]|[^\\"])*"/, rawStrings: true,
};
export const C: Syntax = {
  lineComments: ['//'], blockComment: true, nestedBlock: false, charLiteral: C_CHAR, doubleString: C_STRING, rawStrings: false,
};
export const HASH: Syntax = {
  lineComments: ['#'], blockComment: false, nestedBlock: false, charLiteral: JS_STRING, doubleString: C_STRING, rawStrings: false,
};

// lineStarts returns the offset at which each line of text begins.
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// blockEnd returns the offset just past the */ that closes a block comment opened at start.
function blockEnd(text: string, start: number, nested: boolean): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length) {
    if (nested && text.startsWith('/*', i)) { depth++; i += 2; continue; }
    if (text.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return text.length;
}

// commentsOwn returns every comment of text, one entry per physical line that a comment covers.
export function commentsOwn(text: string, syntax: Syntax): OwnComment[] {
  const starts = lineStarts(text);
  const found: OwnComment[] = [];
  const addSpan = (start: number, end: number) => {
    const first = lineOf(starts, start);
    const firstCol = start - (starts[first - 1] ?? 0);
    text.slice(start, end).split('\n').forEach((part, index) => found.push({ line: first + index, col: index === 0 ? firstCol : 0, text: part }));
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    // A hash escaped by a backslash is a literal character, as in a Makefile, not a comment.
    const escapedHash = ch === '#' && text[i - 1] === '\\';
    const opener = syntax.lineComments.find(prefix => text.startsWith(prefix, i));
    if (opener && !escapedHash) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      addSpan(i, end);
      i = end;
      continue;
    }
    if (syntax.blockComment && text.startsWith('/*', i)) {
      const end = blockEnd(text, i, syntax.nestedBlock);
      addSpan(i, end);
      i = end;
      continue;
    }
    if (syntax.rawStrings && ch === 'r' && (i === 0 || !/\w/.test(text.charAt(i - 1)))) {
      const raw = /^r(#*)"/.exec(text.slice(i, i + 40));
      if (raw) {
        const close = `"${raw[1]}`;
        const end = text.indexOf(close, i + (raw[0]?.length ?? 0));
        i = end === -1 ? text.length : end + close.length;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const literal = ch === '"' ? syntax.doubleString : syntax.charLiteral;
      const match = literal.exec(text.slice(i, i + 65536));
      i += match ? match[0].length : 1;
      continue;
    }
    i++;
  }
  return found;
}
