// Fails when a comment of a tracked code file contains Hangul. Each ecosystem's comments come from its own tokenizer:
// Go from go/scanner (scripts/comments/tokens/go-comments.go), TypeScript and JavaScript from the TypeScript parser of
// the pinned interface project, Python from tokenize and ast (tokens/python-comments.py), and PHP from token_get_all
// (tokens/php-comments.php). Rust, C and the hash-comment files have no tokenizer in their toolchains, so they use the
// lexer of own-lexer.mts, which docs/rebuild/ records. This module aggregates the comment lines and reports each Hangul
// line by file and line number.
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type * as TypeScript from '../../packages/ts/testing/interfaces/typescript/node_modules/typescript/lib/typescript.js';
import { errorMessage } from '../../tests/errors.mts';
import { C, commentsOwn, HASH, RUST } from './own-lexer.mts';

const HANGUL = /\p{Script=Hangul}/u;
const root = resolve(import.meta.dirname, '..', '..');

// Comment is one physical line of a comment, with its column in the line.
export interface Comment {
  line: number;
  col: number;
  text: string;
}

export type Family = 'go' | 'typescript' | 'python' | 'php' | 'rust' | 'c' | 'hash';

// familyOf names the tokenizer of a tracked path, or undefined when the file holds no comment this check reads.
export function familyOf(path: string, firstLine = ''): Family | undefined {
  const name = basename(path);
  const ext = extname(path);
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (['.ts', '.mts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'].includes(ext)) return 'typescript';
  if (ext === '.php') return 'php';
  if (['.c', '.h', '.cpp', '.hpp'].includes(ext)) return 'c';
  if (ext === '.py') return 'python';
  if (['.sh', '.bash', '.mk', '.toml', '.ini', '.yml', '.yaml', '.cfg', '.m4'].includes(ext) || name === 'Makefile' || name === 'Dockerfile') return 'hash';
  if (ext === '' && firstLine.startsWith('#!')) {
    if (/\bphp\b/.test(firstLine)) return 'php';
    if (/\bpython\d*\b/.test(firstLine)) return 'python';
    if (/\b(ba|z)?sh\b/.test(firstLine)) return 'hash';
  }
  return undefined;
}

type Entry = { line: number; col: number; text: string };

// entriesOf reads the JSON that a tokenizer prints: one array of comment entries per path, each with a line, a column and a text.
function entriesOf(text: string): Entry[][] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('the tokenizer printed no array of files');
  return value.map((file: unknown) => {
    if (!Array.isArray(file)) throw new Error('the tokenizer printed a file that is no array');
    return file.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('line' in entry) || typeof entry.line !== 'number' || !('col' in entry) || typeof entry.col !== 'number' || !('text' in entry) || typeof entry.text !== 'string') {
        throw new Error('the tokenizer printed a comment without its line, column and text');
      }
      return { line: entry.line, col: entry.col, text: entry.text };
    });
  });
}

// isTypeScript is the module of the pinned TypeScript: it has the compiler's entry points.
const isTypeScript = (value: unknown): value is typeof TypeScript => typeof value === 'object' && value !== null && 'createSourceFile' in value && typeof value.createSourceFile === 'function';

// splitLines turns an entry that spans several physical lines into one Comment per line; a continuation line starts at column 0.
function splitLines(entries: Entry[]): Comment[] {
  return entries.flatMap(entry => entry.text.split('\n').map((part, index) => ({
    line: entry.line + index,
    col: index === 0 ? entry.col : 0,
    text: part,
  })));
}

// runTokenizer starts a tokenizer with the paths on standard input and returns one entry list per path.
async function runTokenizer(command: string, args: string[], env: NodeJS.ProcessEnv, paths: string[]): Promise<Entry[][]> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => fail(new Error(`${command} cannot start: ${errorMessage(error)}`)));
    child.on('close', code => {
      if (code !== 0) return fail(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      try { done(entriesOf(stdout)); }
      catch (error) { fail(new Error(`${command} printed no JSON: ${errorMessage(error)}`)); }
    });
    child.stdin.end(`${paths.join('\n')}\n`);
  });
}

// typescriptComments reads the comment trivia of every token of a file with the TypeScript parser of the pinned
// interface project: each child token is visited, and its leading and trailing trivia hold every comment.
function typescriptComments(path: string, text: string): Entry[] {
  const require = createRequire(join(root, 'package.json'));
  const loaded: unknown = require(join(root, 'packages/ts/testing/interfaces/typescript/node_modules/typescript'));
  if (!isTypeScript(loaded)) throw new Error('the pinned typescript module exports no createSourceFile');
  const ts = loaded;
  const ext = extname(path);
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const seen = new Set<number>();
  const found: Entry[] = [];
  const visit = (node: TypeScript.Node): void => {
    // A comment on the line of the previous token is trailing trivia of that token, the rest are leading trivia of this one.
    const ranges = [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const { line, character } = sf.getLineAndCharacterOfPosition(range.pos);
      found.push({ line: line + 1, col: character, text: text.slice(range.pos, range.end) });
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return found;
}

// commentsByFile reads the comments of the given paths, relative to dir, and returns each path's comment lines.
// A path with no comment syntax has no entry. A tokenizer that fails stops its batch with its message.
export async function commentsByFile(dir: string, paths: string[]): Promise<Map<string, Comment[]>> {
  const texts = new Map<string, string>();
  for (const path of paths) texts.set(path, await readFile(resolve(dir, path), 'utf8'));
  const families = new Map<Family, string[]>();
  for (const path of paths) {
    const family = familyOf(path, (texts.get(path) ?? '').split('\n', 1)[0]);
    if (family === undefined) continue;
    families.set(family, [...(families.get(family) ?? []), path]);
  }
  const result = new Map<string, Comment[]>();
  for (const [family, files] of families) {
    const entries = await batch(family, files, dir, texts);
    files.forEach((file, index) => result.set(file, splitLines(entries[index] ?? [])));
  }
  return result;
}

// batch runs the tokenizer of one family over its files.
async function batch(family: Family, files: string[], dir: string, texts: Map<string, string>): Promise<Entry[][]> {
  if (family === 'go') {
    return runTokenizer('go', ['run', join(root, 'scripts/comments/tokens/go-comments.go')], { GOWORK: 'off', GOFLAGS: '', GOPROXY: 'off' }, files.map(file => join(dir, file)));
  }
  if (family === 'python') return runTokenizer('python3', ['-I', join(root, 'scripts/comments/tokens/python-comments.py')], {}, files.map(file => join(dir, file)));
  if (family === 'php') return runTokenizer('php', [join(root, 'scripts/comments/tokens/php-comments.php')], {}, files.map(file => join(dir, file)));
  return files.map(file => {
    const text = texts.get(file) ?? '';
    if (family === 'typescript') return typescriptComments(file, text);
    return commentsOwn(text, family === 'rust' ? RUST : family === 'c' ? C : HASH);
  });
}

// hangulComments returns the comment lines that contain Hangul.
export function hangulComments(comments: Comment[]): Comment[] {
  return comments.filter(comment => HANGUL.test(comment.text));
}

// trackedFiles lists the files git tracks in the repository root.
async function trackedFiles(): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\0').filter(path => path !== '');
}

// commentErrors returns one message per Hangul comment line of the tracked code files, naming file and line. With
// prefixes, only the tracked files under those paths are read, so a directory can be checked on its own.
export async function commentErrors(dir: string, prefixes: string[] = []): Promise<string[]> {
  const files = (await trackedFiles()).filter(path => prefixes.length === 0 || prefixes.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
  let byFile: Map<string, Comment[]>;
  try {
    byFile = await commentsByFile(dir, files);
  } catch (error) {
    return [`comment-language-check: a tokenizer failed: ${errorMessage(error)}`];
  }
  const errors: string[] = [];
  for (const path of files) {
    for (const comment of hangulComments(byFile.get(path) ?? [])) {
      errors.push(`${path}:${comment.line}: Hangul in a comment: ${comment.text.trim()}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const errors = await commentErrors(root, process.argv.slice(2));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error(`comment-language-check: ${errors.length} problem(s); translate each Hangul comment to English (AGENTS.md), then rerun make comment-language-check`);
    process.exit(1);
  }
  console.log('comment-language-check: no Hangul in the comments of the tracked code files');
}
