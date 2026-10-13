// orm-gen: the TypeScript model generator.
//
//   orm-gen gen --set <dbspec-set.json> --out src/models [--scan <file or directory>]... [--check]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readDbspecBytes } from '../dbspec/read_bytes.js';
import { readDbspecSet, type DbspecSetFile } from '../dbspec/set_read.js';
import { modelOfDocuments, parseDocumentSet } from '../engine/model.js';
import { generateTypeScript, renderTypeScript } from '../generate/typescript.js';

const usageText = `usage: orm-gen gen --set <dbspec-set.json> --out <directory> [--scan <file or directory>]... [--check]`;

class UsageError extends Error {}

function usage(message?: string): never {
  throw new UsageError(message ?? usageText);
}

/** Accepts -flag as well as --flag. */
function normalize(args: readonly string[]): string[] {
  return args.map(arg => /^-[a-z][a-z-]*(=.*)?$/.test(arg) ? '-' + arg : arg);
}

interface Parsed {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>;
}

function parse(args: readonly string[], options: ParseArgsConfig['options']): Parsed {
  try {
    return parseArgs({ args: normalize(args), options, strict: true, allowPositionals: false }) as Parsed;
  } catch (error) {
    return usage(`orm-gen: ${(error as Error).message}\n${usageText}`);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function message(error: unknown): string {
  return (error as Error).message;
}

/**
 * Compares the generated text with the file at path and returns the check
 * line: `missing` or `differs`, or none when the file holds the text.
 */
function compareFile(path: string, generated: string): string[] {
  let current: string;
  try { current = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [`missing: ${path}`];
    throw error;
  }
  return current === generated ? [] : [`differs: ${path}`];
}

/** Prints the lines of a check and returns exit status 1 when there is a line. */
function report(lines: readonly string[]): number {
  for (const line of lines) process.stdout.write(`${line}\n`);
  return lines.length === 0 ? 0 : 1;
}

/** The error of a set file or of its files, after every error and diagnostic of the set was printed. */
class SetError extends Error {}

/**
 * Reads the set file with readDbspecSet and gives each listed file's bytes to readDbspecBytes with its joined path.
 * On any error or diagnostic it prints all of them and throws SetError; otherwise it returns the texts of the owned
 * and of the external documents in written order.
 */
function readSet(path: string): { documents: string[]; external: string[] } {
  const set = readDbspecSet(path);
  if (set.documents === null) {
    for (const e of set.errors) console.error(`orm-gen: ${e.rule}: ${e.message}`);
    throw new SetError(`${path}: ${set.errors.length} set error(s)`);
  }
  const lines: string[] = [];
  const texts = (files: readonly DbspecSetFile[]): string[] => files.map(file => {
    const read = readDbspecBytes(file.path, file.bytes);
    for (const d of read.diagnostics) lines.push(`orm-gen: ${file.path}:${d.line}:${d.column} ${d.rule}: ${d.message}`);
    return read.text ?? '';
  });
  const documents = texts(set.documents);
  const external = texts(set.external);
  if (lines.length > 0) {
    for (const line of lines) console.error(line);
    throw new SetError(`${path}: ${lines.length} document diagnostic(s)`);
  }
  return { documents, external };
}

/**
 * Generates models.ts from the dbspec documents of the document set that the set file names with --set: the
 * documents it owns and the external documents they use. Only the owned tables get models. Nothing is written when
 * the set file or a listed file has an error or a diagnostic.
 */
function gen(args: readonly string[]): number {
  const { values } = parse(args, {
    set: { type: 'string' }, out: { type: 'string' },
    scan: { type: 'string', multiple: true }, check: { type: 'boolean' },
  });
  const setPath = text(values.set);
  const out = text(values.out);
  if (setPath === '' || out === '') usage();
  const set = readSet(setPath);
  const model = modelOfDocuments(parseDocumentSet(set.documents, set.external));
  const scan = (values.scan as string[] | undefined) ?? [];
  if (values.check === true) return report(compareFile(join(out, 'models.ts'), renderTypeScript(model, out, scan)));
  generateTypeScript(model, out, scan);
  console.error(`orm-gen: ${model.entities.size} models (manifest ${model.manifestHash}) → ${out}/models.ts`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'gen': return gen(args);
    default: return usage();
  }
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  error => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof SetError) {
      console.error(`orm-gen: ${error.message}; nothing was written`);
      process.exitCode = 1;
      return;
    }
    console.error(`orm-gen: ${message(error)}`);
    process.exitCode = 1;
  },
);
