// Reads native declarations with each language's extractor. An extractor is a program that reads declarations with that language's own parser: Go (go/parser,
// packages/go/internal/symbols), PHP(Reflection, packages/php/testing/interfaces/php.php), Rust(syn, packages/rust/testing/interfaces), TypeScript(TypeScript
// compiler API, packages/ts/testing/interfaces/typescript.mts), Python (ast, packages/python/testing/interfaces/python.py). The Go and Rust extractors are execution files built in this run's
// temporary directory. Prohibited multi_statement calls are found in the source text.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseJson } from '../../../scripts/json/schema.mts';
import { stepLines, type Step } from '../../testcase.mts';
import { byteOrder } from './json.mts';
import type { Symbols } from './manifest.mts';

const symbolsSchema = resolve(import.meta.dirname, '../../../scripts/schema/interface-symbols.schema.json');

/** Tools is the extractor execution file built by this run. It is empty in a run that does not check that language. */
export type Tools = { go?: string; rust?: string };

/** Output is the exit code of the finished child process (null if ended by a signal), the signal, stdout, and stderr. */
type Output = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

// exitText writes the state of a finished process the way Go's exec.ExitError does.
function exitText(output: Output): string {
  return output.signal !== null ? `signal: ${output.signal}` : `exit status ${output.code ?? 1}`;
}

// run executes the program and collects its output. If onOutput is given, it also sends both outputs there. If the signal aborts, it ends the process.
function run(program: string, args: string[], options: { cwd?: string; signal?: AbortSignal; onOutput?: (chunk: string) => void } = {}): Promise<Output> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); options.onOutput?.(String(chunk)); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); options.onOutput?.(String(chunk)); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

/**
 * extract reads declarations of roots under root with the lang extractor. toolRoot is the repository
 * root where the PHP, TypeScript, and Python extractor scripts are. If the extractor fails, it is an error containing its exit status and stderr.
 */
export async function extract(signal: AbortSignal | undefined, root: string, lang: string, roots: string[], tools: Tools, toolRoot: string): Promise<Symbols> {
  let program: string, args: string[];
  if (lang === 'go') [program, args] = [tools.go ?? '', [root, ...roots]];
  else if (lang === 'php') [program, args] = ['php', [join(toolRoot, 'packages/php/testing/interfaces/php.php'), root, ...roots]];
  else if (lang === 'typescript') [program, args] = ['node', [join(toolRoot, 'packages/ts/testing/interfaces/typescript.mts'), root, ...roots]];
  else if (lang === 'python') [program, args] = ['python3', [join(toolRoot, 'packages/python/testing/interfaces/python.py'), root, ...roots]];
  else [program, args] = [tools.rust ?? '', [root, ...roots]];
  if (program === '') throw new Error(`${lang} declarations: this run built no ${lang} symbol extractor`);
  let output: Output;
  try {
    output = await run(program, args, signal ? { signal } : {});
  } catch (error) {
    throw new Error(`${lang} declarations: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (output.code !== 0) throw new Error(`${lang} declarations: ${exitText(output)}\n${output.stderr}`);
  return parseJson<Symbols>(output.stdout, symbolsSchema, `${lang} declarations`);
}

/**
 * buildGo builds the Go symbol extractor (packages/go/internal/symbols) into a directory and returns its execution file. The compiler's output is shown as step
 * lines.
 */
export async function buildGo(step: Step, root: string, directory: string): Promise<string> {
  const executable = join(directory, 'polyspec-orm-interface-symbols-go');
  const lines = stepLines(step);
  step('run go build -o <directory> ./packages/go/internal/symbols');
  const output = await run('go', ['build', '-o', executable, './packages/go/internal/symbols'], { cwd: root, onOutput: chunk => lines.write(chunk) });
  lines.flush();
  if (output.code !== 0) throw new Error(`go build: ${exitText(output)}`);
  return executable;
}

/**
 * buildRust builds the Rust symbol tool under the exclusive lease of the shared Rust target directory (LEASE, CARGO_LEASES, --wait),
 * and returns the execution file copied into the directory under that lease (scripts/cargo-build-copy.mts). Even if the target directory of another build in this checkout
 * changes, this run's extractor does not change. The build is a long task, so it has no deadline, and cargo's progress output is shown as step lines with the elapsed
 * time.
 */
export async function buildRust(step: Step, root: string, directory: string): Promise<string> {
  const lease = process.env['LEASE'] ?? '', leases = process.env['CARGO_LEASES'] ?? '';
  if (lease === '' || leases === '') throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
  const manifest = join(root, 'packages/rust/testing/interfaces/Cargo.toml');
  const lines = stepLines(step);
  step(`run cargo build --locked --manifest-path ${manifest} under the target lease`);
  const output = await run(lease, ['run', leases, 'exclusive', '--wait', '--', 'node', join(root, 'scripts', 'cargo-build-copy.mts'),
    directory, 'debug/polyspec-orm-interface-symbols', '--', 'cargo', 'build', '--locked', '--manifest-path', manifest], { onOutput: chunk => lines.write(chunk) });
  lines.flush();
  if (output.code !== 0) throw new Error(`cargo build: ${exitText(output)}`);
  const executable = join(directory, 'debug', 'polyspec-orm-interface-symbols');
  let file = false;
  try {
    file = statSync(executable).isFile();
  } catch (error) {
    throw new Error(`cargo build left no executable ${executable}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!file) throw new Error(`cargo build left no executable ${executable}: it is a directory`);
  return executable;
}

const PROHIBITED_CALLS: Record<string, RegExp> = {
  go: /\.\s*MultiStatement\s*\(/,
  php: /(?:->|::)\s*multi_statement\s*\(/,
  rust: /(?:\.|::)\s*multi_statement\s*\(/,
  typescript: /\.\s*multiStatement\s*\(/,
  python: /\.\s*multi_statement\s*\(/,
};

/** checkProhibitedCalls returns one line if the source calls multi_statement. */
export function checkProhibitedCalls(lang: string, source: string): string[] {
  const pattern = PROHIBITED_CALLS[lang];
  if (pattern === undefined) return [`unsupported language ${lang}`];
  return pattern.test(source) ? [`${lang}: prohibited multi_statement call`] : [];
}

const EXTENSIONS: Record<string, string> = { go: '.go', php: '.php', rust: '.rs', typescript: '.ts', python: '.py' };

// walkFiles returns files under a directory in byte order of names, like Go's filepath.WalkDir. It does not follow symlinks.
function walkFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => byteOrder(a.name, b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

/** checkCallsInRoots finds multi_statement calls in each lang source file of roots under root (excluding Go test files). */
export function checkCallsInRoots(root: string, lang: string, roots: string[]): string[] {
  const ext = EXTENSIONS[lang];
  if (ext === undefined) throw new Error(`unsupported language ${lang}`);
  const failures: string[] = [];
  for (const sourceRoot of roots) {
    const start = join(root, sourceRoot);
    const files = statSync(start).isDirectory() ? walkFiles(start) : [start];
    for (const path of files) {
      if (extname(path) !== ext || path.endsWith('_test.go')) continue;
      if (checkProhibitedCalls(lang, readFileSync(path, 'utf8')).length !== 0) failures.push(`${path}: prohibited multi_statement call`);
    }
  }
  return failures;
}
