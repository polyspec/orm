// orm-gen: the TypeScript model generator.
//
//   orm-gen gen --schema <document.dbspec>... --out src/models [--scan <file or directory>]... [--check]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { modelOfDocuments, parseDocumentSet } from '../engine/model.js';
import { generateTypeScript, renderTypeScript } from '../generate/typescript.js';

const usageText = `usage: orm-gen gen --schema <document.dbspec>... --out <directory> [--scan <file or directory>]... [--check]`;

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

/** Generates models.ts from the dbspec documents of one document set, each named by --schema. */
function gen(args: readonly string[]): number {
  const { values } = parse(args, { schema: { type: 'string', multiple: true }, out: { type: 'string' }, scan: { type: 'string', multiple: true }, check: { type: 'boolean' } });
  const schemas = (values.schema as string[] | undefined) ?? [];
  const out = text(values.out);
  if (schemas.length === 0 || out === '') usage();
  const model = modelOfDocuments(parseDocumentSet(schemas.map(path => readFileSync(path, 'utf8'))));
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
    console.error(`orm-gen: ${message(error)}`);
    process.exitCode = 1;
  },
);
