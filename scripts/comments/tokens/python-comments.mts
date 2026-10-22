#!/usr/bin/env node
// Prints the comment tokens of Python source files (KSTD-5-21), the TypeScript port of python-comments.py.
//
// Comments are the `#` comments outside strings. A docstring is the first statement of a module, a class or a function
// whose only expression is a plain string literal (no f-string, no bytes string, no operator), and each docstring is one
// entry that spans its lines. The file paths come one per line on standard input. The output is one JSON array per path,
// in input order; each entry holds the line, the column and the text, and a multi-line entry keeps its newlines in text.
// Columns count characters of the line, so a line with non-ASCII characters before an entry has the column of its characters.
//
//   node scripts/comments/tokens/python-comments.mts < paths.txt
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** One comment or docstring entry: its line (from 1), its column (from 0) and its text. */
interface Entry {
  line: number;
  col: number;
  text: string;
}

/** One token of the Python source: its kind, its text, and where it starts and ends (line from 1, column from 0). */
interface Token {
  kind: 'comment' | 'string' | 'name' | 'op' | 'newline' | 'nl' | 'other';
  text: string;
  prefix: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** The string prefixes of Python, lower case, in any order. */
const PREFIXES = new Set(['r', 'u', 'b', 'f', 'br', 'rb', 'fr', 'rf']);

/** Splits Python source into tokens of the kinds that the comment and docstring reading needs. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  while (i < n) {
    const ch = source.charAt(i);
    if (ch === '\n') {
      const startLine = line;
      const startCol = i - lineStart;
      i++;
      tokens.push({ kind: depth > 0 ? "nl" : "newline", text: "\n", prefix: "", line: startLine, col: startCol, endLine: startLine, endCol: startCol + 1 });
      line++;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '#') {
      const start = i;
      const startLine = line;
      const startCol = i - lineStart;
      while (i < n && source.charAt(i) !== '\n') i++;
      let text = source.slice(start, i);
      if (text.endsWith('\r')) text = text.slice(0, -1);
      tokens.push({ kind: 'comment', text, prefix: '', line: startLine, col: startCol, endLine: startLine, endCol: startCol + text.length });
      continue;
    }
    if (ch === '\\' && source.charAt(i + 1) === '\n') {
      i += 2;
      line++;
      lineStart = i;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      const startLine = line;
      const startCol = i - lineStart;
      while (i < n && /[A-Za-z0-9_]/.test(source.charAt(i))) i++;
      const word = source.slice(start, i).toLowerCase();
      if ((source.charAt(i) === '"' || source.charAt(i) === "'") && PREFIXES.has(word)) {
        const end = scanString(source, i);
        line += end.newlines;
        lineStart = end.lineStart;
        i = end.stop;
        tokens.push({ kind: 'string', text: source.slice(start, i), prefix: word, line: startLine, col: startCol, endLine: line, endCol: i - lineStart });
        continue;
      }
      tokens.push({ kind: 'name', text: source.slice(start, i), prefix: '', line: startLine, col: startCol, endLine: startLine, endCol: startCol + word.length });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const startCol = i - lineStart;
      const start = i;
      const end = scanString(source, i);
      line += end.newlines;
      lineStart = end.lineStart;
      i = end.stop;
      tokens.push({ kind: 'string', text: source.slice(start, i), prefix: '', line: startLine, col: startCol, endLine: line, endCol: i - lineStart });
      continue;
    }
    const startLine = line;
    const startCol = i - lineStart;
    const start = i;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    i++;
    tokens.push({ kind: 'op', text: source.slice(start, i), prefix: '', line: startLine, col: startCol, endLine: startLine, endCol: startCol + 1 });
  }
  return tokens;
}

/** Reads a string literal that starts at `start` (its quote), and returns where it stops and the lines it spans. */
function scanString(source: string, start: number): { stop: number; newlines: number; lineStart: number } {
  const quote = source.charAt(start);
  const triple = source.startsWith(quote.repeat(3), start);
  const close = triple ? quote.repeat(3) : quote;
  let i = start + close.length;
  let newlines = 0;
  let lineStart = -1;
  while (true) {
    if (i >= source.length) throw new Error(`unterminated string at offset ${start}`);
    const ch = source.charAt(i);
    if (ch === '\\') {
      if (source.charAt(i + 1) === '\n') {
        newlines++;
        lineStart = i + 2;
      }
      i += 2;
      continue;
    }
    if (ch === '\n') {
      if (!triple) throw new Error(`unterminated string at offset ${start}`);
      newlines++;
      lineStart = i + 1;
      i++;
      continue;
    }
    if (source.startsWith(close, i)) {
      i += close.length;
      break;
    }
    i++;
  }
  // lineStart is the offset after the last newline of the string, or the line start the caller already knows.
  return { stop: i, newlines, lineStart: lineStart === -1 ? lineStartOf(source, start) : lineStart };
}

/** The offset of the first character of the line that holds `offset`. */
function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/** The logical lines of the tokens: each is the tokens between two newlines that end a statement, without comments and NL. */
function logicalLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'comment' || token.kind === 'nl') continue;
    if (token.kind === 'newline') {
      if (current.length > 0) lines.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** The tokens of a statement that is a plain string expression, or undefined: strings only, no f-string and no bytes, parentheses aside. */
function docstringOf(statement: Token[]): Token[] | undefined {
  let parts = statement;
  if (parts.length >= 3 && parts[0]?.text === '(' && parts.at(-1)?.text === ')') parts = parts.slice(1, -1);
  if (parts.length === 0) return undefined;
  for (const token of parts) {
    if (token.kind !== 'string' || token.prefix.includes('f') || token.prefix.includes('b')) return undefined;
  }
  return parts;
}

/** The statement of a logical line that ends before a `;` at depth 0, so that `"doc"; x = 1` is read as its first statement. */
function firstStatement(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === ';' && depth === 0) break;
    if (token.text === '(' || token.text === '[' || token.text === '{') depth++;
    if (token.text === ')' || token.text === ']' || token.text === '}') depth--;
    out.push(token);
  }
  return out;
}

/** The index of the `:` that ends a def or class header, at bracket depth 0, or -1. */
function headerColon(tokens: Token[]): number {
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const text = tokens[k]?.text;
    if (text === '(' || text === '[' || text === '{') depth++;
    else if (text === ')' || text === ']' || text === '}') depth--;
    else if (text === ':' && depth === 0) return k;
  }
  return -1;
}

/** The entry of a docstring whose tokens are `parts`, with its text taken from the source lines as the reader of the tokens. */
function entryOf(parts: Token[], lines: string[]): Entry {
  const first = parts[0];
  const last = parts.at(-1);
  if (first === undefined || last === undefined) throw new Error('a docstring has no tokens');
  let text: string;
  if (first.line === last.endLine) {
    text = (lines[first.line - 1] ?? '').slice(first.col, last.endCol);
  } else {
    const middle = lines.slice(first.line, last.endLine - 1);
    text = [(lines[first.line - 1] ?? '').slice(first.col), ...middle, (lines[last.endLine - 1] ?? '').slice(0, last.endCol)].join('\n');
  }
  return { line: first.line, col: first.col, text };
}

/** The docstrings of the module, its classes and its functions, as entries. */
function docstringEntries(source: string, tokens: Token[]): Entry[] {
  const lines = source.split('\n');
  const logical = logicalLines(tokens);
  const out: Entry[] = [];
  const first = logical[0];
  if (first !== undefined) {
    const statement = docstringOf(firstStatement(first));
    if (statement !== undefined) out.push(entryOf(statement, lines));
  }
  for (let index = 0; index < logical.length; index++) {
    const tokensOfLine = logical[index];
    const head = tokensOfLine?.[0];
    if (tokensOfLine === undefined || head === undefined) continue;
    const starts = head.kind === 'name' && (head.text === 'def' || head.text === 'class' || (head.text === 'async' && tokensOfLine[1]?.text === 'def'));
    if (!starts) continue;
    const colon = headerColon(tokensOfLine);
    if (colon === -1) continue;
    let body: Token[] | undefined;
    if (colon + 1 < tokensOfLine.length) {
      // a one-line body: `def f(): "doc"`
      body = tokensOfLine.slice(colon + 1);
    } else if (index + 1 < logical.length) {
      body = logical[index + 1];
    }
    if (body === undefined) continue;
    const statement = docstringOf(firstStatement(body));
    if (statement !== undefined) out.push(entryOf(statement, lines));
  }
  return out;
}

/** The entries of one Python source: its comments and its docstrings, sorted by line and column. */
export function commentsOf(source: string): Entry[] {
  const tokens = tokenize(source);
  const entries: Entry[] = [];
  for (const token of tokens) {
    if (token.kind !== 'comment') continue;
    entries.push({ line: token.line, col: token.col, text: token.text });
  }
  entries.push(...docstringEntries(source, tokens));
  entries.sort((a, b) => a.line - b.line || a.col - b.col);
  return entries;
}

/** Reads the paths from standard input, prints one JSON array of entries per path, and exits with 1 when a file fails. */
function main(): number {
  const paths = readFileSync(0, 'utf8').split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const out: Entry[][] = [];
  let failed = false;
  for (const path of paths) {
    try {
      out.push(commentsOf(readFileSync(path, 'utf8')));
    } catch (error) {
      process.stderr.write(`python-comments: ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
      failed = true;
      out.push([]);
    }
  }
  if (failed) return 1;
  process.stdout.write(JSON.stringify(out));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
