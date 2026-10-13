// The command line dbspec-fmt (docs/plans/editor-stack.md T128-5): it prints, rewrites or checks the formatted text of
// the dbspec documents it is given, each analyzed with the document set that resolveSet gives. It follows the rules of
// template-fmt (polyspec/template docs/operations/editor-tools.md), except that it takes the paths it is given and
// walks no directory: a set file declares the documents of a set (ruling 4).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readDbspecFile } from '@polyspec/orm';
import { readDbspecBytes, type DbspecDiagnostic } from '@polyspec/orm/dbspec';
import { openDocument, type Diagnostic } from '../document.js';
import { resolveSet } from '../set.js';
import { codePointColumn, parserLines } from '../utf16.js';
import { nodeSetHost } from './host.js';

const STDIN_NAME = '<stdin>';
const WINDOWS = process.platform === 'win32';

export const USAGE = `usage: dbspec-fmt [--write | --check] [PATH ...]

Formats dbspec documents. Each file is analyzed with its document set: the documents of the
dbspec-set.json in the nearest ancestor directory that lists it; a file that no set file
lists, and standard input, form a set of themselves alone.

  PATH      a dbspec document file; "-" or no PATH reads standard input and writes
            standard output. A directory is not searched.
  --write   rewrite every file that is not formatted and print its path
  --check   change nothing; print the path of every file that is not formatted
  --help    print this text

Without --write or --check, exactly one file or standard input is formatted to standard output.
Every path is processed, and the highest exit status wins.

Exit status: 0 formatted, or nothing to change; 1 --check found a file that is not formatted;
2 a diagnostic, a set error, a path that cannot be read or written, or invalid arguments.
`;

type Mode = 'print' | 'write' | 'check';

function reason(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function usageError(message: string): number {
  process.stderr.write(`dbspec-fmt: ${message}\n${USAGE}`);
  return 2;
}

/** Writes one stderr line `path:line:col: LABEL: message`; the label is the rule. */
function report(path: string, d: { readonly line: number; readonly column: number; readonly rule: string; readonly message: string }): void {
  process.stderr.write(`${path}:${d.line}:${d.column}: ${d.rule}: ${d.message}\n`);
}

/** The diagnostics of the language service at the parser's line and code point column. */
function reportDiagnostics(path: string, text: string, diagnostics: readonly Diagnostic[]): void {
  const lines = parserLines(text);
  for (const d of diagnostics) {
    const { line, character } = d.range.start;
    report(path, { line: line + 1, column: codePointColumn(lines[line]!, character), rule: d.rule, message: d.message });
  }
}

function reportRead(path: string, diagnostics: readonly DbspecDiagnostic[]): number {
  for (const d of diagnostics) report(path, d);
  return 2;
}

/**
 * Formats one text with its set and acts by the mode: print writes the text to stdout; check and write print the
 * name of a text that is not formatted, and write rewrites its file. Returns the exit status of the text.
 */
function formatText(name: string, text: string, set: Readonly<Record<string, string>>, mode: Mode, write: (text: string) => void): number {
  const formatted = openDocument(text, { set }).format();
  if (formatted.text === null) {
    reportDiagnostics(name, text, formatted.diagnostics);
    return 2;
  }
  if (mode === 'print') {
    process.stdout.write(formatted.text);
    return 0;
  }
  if (formatted.text === text) return 0;
  if (mode === 'write') {
    try {
      write(formatted.text);
    } catch (thrown) {
      process.stderr.write(`dbspec-fmt: ${name}: cannot be written: ${reason(thrown)}\n`);
      return 2;
    }
  }
  process.stdout.write(`${name}\n`);
  return mode === 'check' ? 1 : 0;
}

/** The absolute path of a command line path with `/` separators, as resolveSet takes it. */
function absolute(path: string): string {
  const full = resolve(path);
  return WINDOWS ? full.replaceAll('\\', '/') : full;
}

/** Formats the file at `path`: its bytes are checked, its set resolved and its text formatted. */
function formatFile(path: string, mode: Mode): number {
  let read;
  try {
    read = readDbspecFile(path);
  } catch (thrown) {
    process.stderr.write(`dbspec-fmt: ${path}: cannot be read: ${reason(thrown)}\n`);
    return 2;
  }
  if (read.text === null) return reportRead(path, read.diagnostics);
  const resolved = resolveSet(absolute(path), nodeSetHost);
  if (resolved.set === null) {
    for (const e of resolved.errors) process.stderr.write(`dbspec-fmt: ${e.rule}: ${e.message}\n`);
    return 2;
  }
  // A diagnostic of another file of the set stays visible, and that file is not in the set; the file is still
  // formatted with the set (ruling 4, "Failures").
  for (const d of resolved.diagnostics) report(d.path, d);
  const status = formatText(path, read.text, resolved.set, mode, text => writeFileSync(path, text));
  return resolved.diagnostics.length > 0 ? 2 : status;
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** Runs the command with the given arguments and returns the exit status. */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { write: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (thrown) {
    return usageError(reason(thrown));
  }
  const { values, positionals: paths } = parsed;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.write === true && values.check === true) return usageError('--write and --check cannot be combined');
  const mode: Mode = values.write === true ? 'write' : values.check === true ? 'check' : 'print';
  const stdin = paths.length === 0 || (paths.length === 1 && paths[0] === '-');
  if (!stdin && paths.includes('-')) return usageError('"-" cannot be combined with other paths');

  if (stdin) {
    if (mode === 'write') return usageError('--write requires a path');
    const read = readDbspecBytes(STDIN_NAME, await readStdin());
    if (read.text === null) return reportRead(STDIN_NAME, read.diagnostics);
    // Standard input has no path, so no set file lists it: it is a set of itself alone.
    return formatText(STDIN_NAME, read.text, {}, mode, () => {
      throw new Error('standard input is not written');
    });
  }

  if (mode === 'print' && paths.length !== 1) return usageError('several paths require --write or --check');
  let status = 0;
  for (const path of paths) status = Math.max(status, formatFile(path, mode));
  return status;
}
