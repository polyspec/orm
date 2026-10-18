// Fails when a comment of a tracked code file contains Hangul. Each file's comments come from a lexer of
// its language family, which skips strings, so Hangul in a string literal or a fixture is not a comment.
// Every reported line names its file and line number.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { errorMessage } from '../../tests/errors.mts';

const execFileAsync = promisify(execFile);
const HANGUL = /\p{Script=Hangul}/u;

export interface Comment {
  line: number;
  // col is the offset in the line where text starts; a continuation line of a block comment starts at 0.
  col: number;
  text: string;
}

// The lexical rules of one language family. A family lists what starts a comment and what starts a string.
interface Syntax {
  lineComments: string[];
  blockComment: boolean;
  nestedBlock: boolean;
  // Single-quoted literals: rune or char literals (Go, Rust) take an escape-aware single character.
  charLiteral: RegExp;
  // Double-quoted literals; Rust and Python strings may span lines.
  doubleString: RegExp;
  // Backquoted raw strings (Go), template literals (TypeScript/JavaScript) or none.
  backtick: RegExp | undefined;
  rawStrings: boolean;
  tripleQuotes: boolean;
  // PHP attributes start with `#[` and are code, not comments.
  phpAttribute: boolean;
}

const C_STRING = /^"(?:\\[\s\S]|[^\\"\n])*"/;
const C_CHAR = /^'(?:\\.[^'\n]*|[^\\'\n])'/;
const JS_STRING = /^'(?:\\.|[^\\'\n])*'/;
const C_BLOCK: Pick<Syntax, 'blockComment' | 'nestedBlock'> = { blockComment: true, nestedBlock: false };

const GO: Syntax = {
  lineComments: ['//'], ...C_BLOCK, charLiteral: C_CHAR, doubleString: C_STRING, backtick: /^`[^`]*`/,
  rawStrings: false, tripleQuotes: false, phpAttribute: false,
};
const RUST: Syntax = {
  lineComments: ['//'], blockComment: true, nestedBlock: true, charLiteral: C_CHAR,
  doubleString: /^"(?:\\[\s\S]|[^\\"])*"/, backtick: undefined, rawStrings: true, tripleQuotes: false, phpAttribute: false,
};
const TS: Syntax = {
  lineComments: ['//'], ...C_BLOCK, charLiteral: JS_STRING, doubleString: C_STRING,
  backtick: /^`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`/, rawStrings: false, tripleQuotes: false, phpAttribute: false,
};
const PHP: Syntax = {
  lineComments: ['//', '#'], ...C_BLOCK, charLiteral: JS_STRING, doubleString: C_STRING, backtick: undefined,
  rawStrings: false, tripleQuotes: false, phpAttribute: true,
};
const C: Syntax = { ...GO, backtick: undefined };
const PYTHON: Syntax = {
  lineComments: ['#'], blockComment: false, nestedBlock: false, charLiteral: JS_STRING,
  doubleString: /^"(?:\\[\s\S]|[^\\"\n])*"/, backtick: undefined, rawStrings: false, tripleQuotes: true, phpAttribute: false,
};
const HASH: Syntax = {
  lineComments: ['#'], blockComment: false, nestedBlock: false, charLiteral: JS_STRING,
  doubleString: C_STRING, backtick: undefined, rawStrings: false, tripleQuotes: false, phpAttribute: false,
};

// syntaxOf names the family of a tracked path, or undefined when the file holds no comment this check reads.
export function syntaxOf(path: string, firstLine = ''): Syntax | undefined {
  const name = basename(path);
  const ext = extname(path);
  if (ext === '.go') return GO;
  if (ext === '.rs') return RUST;
  if (['.ts', '.mts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'].includes(ext)) return TS;
  if (ext === '.php') return PHP;
  if (['.c', '.h', '.cpp', '.hpp'].includes(ext)) return C;
  if (ext === '.py') return PYTHON;
  if (['.sh', '.bash', '.mk', '.toml', '.ini', '.yml', '.yaml', '.cfg', '.m4'].includes(ext) || name === 'Makefile' || name === 'Dockerfile') return HASH;
  if (ext === '' && firstLine.startsWith('#!')) {
    if (/\bphp\b/.test(firstLine)) return PHP;
    if (/\bpython\d*\b/.test(firstLine)) return PYTHON;
    if (/\b(ba|z)?sh\b/.test(firstLine)) return HASH;
  }
  return undefined;
}

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

// commentsOf returns every comment of text, one entry per physical line that the comment covers.
export function commentsOf(text: string, syntax: Syntax): Comment[] {
  const starts = lineStarts(text);
  const found: Comment[] = [];
  const addSpan = (start: number, end: number) => {
    const first = lineOf(starts, start);
    const firstCol = start - (starts[first - 1] ?? 0);
    text.slice(start, end).split('\n').forEach((part, index) => found.push({ line: first + index, col: index === 0 ? firstCol : 0, text: part }));
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    // A hash escaped by a backslash is a literal character, as in a Makefile, not a comment.
    const escapedHash = text[i] === '#' && text[i - 1] === '\\';
    const opener = syntax.lineComments.find(prefix => text.startsWith(prefix, i));
    if (opener && !escapedHash && !(syntax.phpAttribute && text.startsWith('#[', i))) {
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
    if (syntax.rawStrings && ch === 'r' && (i === 0 || !/\w/.test(text[i - 1] as string))) {
      const raw = /^r(#*)"/.exec(text.slice(i, i + 40));
      if (raw) {
        const close = `"${raw[1]}`;
        const end = text.indexOf(close, i + raw[0].length);
        i = end === -1 ? text.length : end + close.length;
        continue;
      }
    }
    if (syntax.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      const close = text.indexOf(quote, i + 3);
      const end = close === -1 ? text.length : close + 3;
      // A triple-quoted string that begins its line is a docstring or a block of prose, so it is a comment.
      const lineStart = starts[lineOf(starts, i) - 1] ?? 0;
      if (text.slice(lineStart, i).trim() === '') addSpan(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const literal = ch === '`' ? syntax.backtick : ch === '"' ? syntax.doubleString : syntax.charLiteral;
      const match = literal ? literal.exec(text.slice(i, i + 65536)) : null;
      i += match ? match[0].length : 1;
      continue;
    }
    i++;
  }
  return found;
}

// hangulComments returns the comment lines of one file that contain Hangul, or none when the file has no comment syntax.
export function hangulComments(path: string, text: string): Comment[] {
  const syntax = syntaxOf(path, text.split('\n', 1)[0]);
  if (!syntax) return [];
  return commentsOf(text, syntax).filter(comment => HANGUL.test(comment.text));
}

// trackedFiles lists the files git tracks in the repository root.
async function trackedFiles(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\0').filter(path => path !== '');
}

// commentErrors returns one message per Hangul comment line of the tracked code files, naming file and line. With
// prefixes, only the tracked files under those paths are read, so a directory can be checked on its own.
export async function commentErrors(root: string, prefixes: string[] = []): Promise<string[]> {
  const errors: string[] = [];
  const files = (await trackedFiles(root)).filter(path => prefixes.length === 0 || prefixes.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
  for (const path of files) {
    let text: string;
    try { text = await readFile(resolve(root, path), 'utf8'); }
    catch (error) {
      // A tracked symbolic link or a file removed from the working tree has no text to read.
      errors.push(`${path}: cannot read the file: ${errorMessage(error)}`);
      continue;
    }
    for (const comment of hangulComments(path, text)) {
      errors.push(`${path}:${comment.line}: Hangul in a comment: ${comment.text.trim()}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(import.meta.dirname, '..', '..');
  const errors = await commentErrors(root, process.argv.slice(2));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error(`comment-language-check: ${errors.length} comment line(s) contain Hangul; translate each comment to English (AGENTS.md), then rerun make comment-language-check`);
    process.exit(1);
  }
  console.log('comment-language-check: no Hangul in the comments of the tracked code files');
}
