// native 선언을 각 언어의 추출기로 읽는다. 추출기는 그 언어 자신의 parser로 선언을 읽는 program이다: Go(go/parser,
// tests/interfaces/go), PHP(Reflection, tests/interfaces/php.php), Rust(syn, tests/interfaces/rust), TypeScript(TypeScript
// compiler API, tests/interfaces/typescript.mts), Python(ast, tests/interfaces/python.py). Go와 Rust의 추출기는 이 실행의
// 임시 directory에 build한 실행 file이다. 금지된 multi_statement 호출은 source text에서 찾는다.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseJson } from '../../../scripts/json/schema.mts';
import { stepLines, type Step } from '../../testcase.mts';
import { byteOrder } from './json.mts';
import type { Symbols } from './manifest.mts';

const symbolsSchema = resolve(import.meta.dirname, '../../../scripts/schema/interface-symbols.schema.json');

/** Tools는 이 실행이 build한 추출기 실행 file이다. 그 언어를 확인하지 않는 실행에서는 비어 있다. */
export type Tools = { go?: string; rust?: string };

/** Output은 끝난 하위 process의 종료 코드(signal로 끝났으면 null), signal, 표준 출력과 표준 오류다. */
type Output = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

// exitText는 끝난 process의 상태를 Go의 exec.ExitError처럼 적는다.
function exitText(output: Output): string {
  return output.signal !== null ? `signal: ${output.signal}` : `exit status ${output.code ?? 1}`;
}

// run은 program을 실행해 그 출력을 모은다. onOutput이 있으면 두 출력을 그것으로도 보낸다. signal이 abort되면 process를 끝낸다.
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
 * extract는 lang 추출기로 root 아래 roots의 선언을 읽는다. toolRoot는 PHP, TypeScript, Python 추출기 script가 있는 저장소
 * root다. 추출기가 실패하면 그 종료 상태와 표준 오류를 담은 error다.
 */
export async function extract(signal: AbortSignal | undefined, root: string, lang: string, roots: string[], tools: Tools, toolRoot: string): Promise<Symbols> {
  let program: string, args: string[];
  if (lang === 'go') [program, args] = [tools.go ?? '', [root, ...roots]];
  else if (lang === 'php') [program, args] = ['php', [join(toolRoot, 'tests/interfaces/php.php'), root, ...roots]];
  else if (lang === 'typescript') [program, args] = ['node', [join(toolRoot, 'tests/interfaces/typescript.mts'), root, ...roots]];
  else if (lang === 'python') [program, args] = ['python3', [join(toolRoot, 'tests/interfaces/python.py'), root, ...roots]];
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
 * buildGo는 Go symbol 추출기(tests/interfaces/go)를 directory에 build하고 그 실행 file을 돌려준다. compiler의 출력은 step
 * 줄로 보인다.
 */
export async function buildGo(step: Step, root: string, directory: string): Promise<string> {
  const executable = join(directory, 'polyspec-orm-interface-symbols-go');
  const lines = stepLines(step);
  step('run go build -o <directory> ./tests/interfaces/go');
  const output = await run('go', ['build', '-o', executable, './tests/interfaces/go'], { cwd: root, onOutput: chunk => lines.write(chunk) });
  lines.flush();
  if (output.code !== 0) throw new Error(`go build: ${exitText(output)}`);
  return executable;
}

/**
 * buildRust는 Rust symbol 도구를 공유 Rust target directory의 exclusive lease(LEASE, CARGO_LEASES, --wait) 아래에서 build하고,
 * 그 lease 안에서 directory로 복사한 실행 file을 돌려준다(scripts/cargo-build-copy.mts). 이 checkout의 다른 실행의 build가
 * target directory를 바꿔도 이 실행의 추출기는 바뀌지 않는다. build는 장기 작업이므로 기한이 없고, cargo의 진행 출력은 경과
 * 시간과 함께 step 줄로 보인다.
 */
export async function buildRust(step: Step, root: string, directory: string): Promise<string> {
  const lease = process.env['LEASE'] ?? '', leases = process.env['CARGO_LEASES'] ?? '';
  if (lease === '' || leases === '') throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
  const manifest = join(root, 'tests/interfaces/rust/Cargo.toml');
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

/** checkProhibitedCalls는 source가 multi_statement를 호출하면 한 줄을 돌려준다. */
export function checkProhibitedCalls(lang: string, source: string): string[] {
  const pattern = PROHIBITED_CALLS[lang];
  if (pattern === undefined) return [`unsupported language ${lang}`];
  return pattern.test(source) ? [`${lang}: prohibited multi_statement call`] : [];
}

const EXTENSIONS: Record<string, string> = { go: '.go', php: '.php', rust: '.rs', typescript: '.ts', python: '.py' };

// walkFiles는 directory 아래의 file을 Go의 filepath.WalkDir처럼 이름의 byte 순서로 돌려준다. symlink는 따라가지 않는다.
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

/** checkCallsInRoots는 root 아래 roots의 lang source file(Go test file은 빼고)마다 multi_statement 호출을 찾는다. */
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
