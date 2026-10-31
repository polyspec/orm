// Compile temporary consumers of the real generated Rust model with the existing Rust package manifest and lock file.
import { spawn } from 'node:child_process';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { readJsonFile } from '../json/schema.mts';

type Fixture = {
  id: string;
  expect: 'success' | 'error';
  source: string;
  code?: string;
  diagnostic?: string;
  sourceLine?: string;
};
type CompilerMessage = {
  reason: 'compiler-message';
  message: {
    level: string;
    message: string;
    code?: { code: string };
    spans: { is_primary: boolean; file_name: string; text: { text: string }[] }[];
  };
};

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const manifest = join(root, 'packages/rust/Cargo.toml');
const examples = join(root, 'packages/rust/tests/examples');
const fixtures = readJsonFile<Fixture[]>(join(root, 'packages/rust/testing/compiler-fixtures/cases.json'), join(root, 'scripts/rust/compiler-fixtures.schema.json'));
const toolchain = process.argv[2];
const target = process.env.CARGO_TARGET_DIR;
const features = process.env.ORM_RUST_TEST_FEATURES;
const checkout = resolve(process.cwd());
const expectedTarget = resolve(dirname(manifest), 'target');
if (typeof toolchain !== 'string' || toolchain === '' || typeof features !== 'string' || features === ''
  || checkout !== root || typeof target !== 'string' || target === '' || resolve(target) !== expectedTarget) {
  throw new Error('compiler fixtures need the pinned Rust toolchain, test features, and this checkout’s CARGO_TARGET_DIR; run make rust-compiler-fixtures-check');
}
const selectedToolchain = toolchain;
const selectedFeatures = features;
const selectedTarget = target;
const caseArguments = process.argv.slice(3);
const requestedCases: string[] = [];
for (let index = 0; index < caseArguments.length; index++) {
  const argument = caseArguments[index];
  if (argument === '--case') {
    const id = caseArguments[++index];
    if (id === undefined || id === '' || id.startsWith('--')) throw new Error('--case needs a compiler fixture id');
    requestedCases.push(id);
  } else if (argument?.startsWith('--case=')) {
    const id = argument.slice('--case='.length);
    if (id === '') throw new Error('--case needs a compiler fixture id');
    requestedCases.push(id);
  } else {
    throw new Error(`unknown compiler fixture argument ${argument}`);
  }
}

const seen = new Set<string>();
for (const fixture of fixtures) {
  if (!/^[a-z0-9-]+$/.test(fixture.id) || seen.has(fixture.id)) throw new Error(`invalid or duplicate Rust compiler fixture id ${fixture.id}`);
  seen.add(fixture.id);
  if (fixture.expect === 'error' && (!fixture.code || !fixture.diagnostic || !fixture.sourceLine || !fixture.source.includes(fixture.sourceLine))) {
    throw new Error(`${fixture.id} needs an expected diagnostic and its source line`);
  }
}
const known = new Set(fixtures.map(fixture => fixture.id));
// Each case is one trial of packages/rust/orm/tests/compiler_fixtures.rs, which runs this runner with that case.
if (requestedCases.length === 0) throw new Error('select a compiler fixture with --case; make rust-compiler-fixtures-check runs every case as its own trial');
if (new Set(requestedCases).size !== requestedCases.length) throw new Error('compiler fixture selections must be unique');
for (const id of requestedCases) if (!known.has(id)) throw new Error(`unknown Rust compiler fixture ${id}`);
const selected = new Set(requestedCases);
const selectedFixtures = fixtures.filter(fixture => selected.has(fixture.id));

function check(id: string, source: string): Promise<{ status: number | null; signal: NodeJS.Signals | null; messages: CompilerMessage[] }> {
  return new Promise((resolveRun, rejectRun) => {
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
    const child = spawn('cargo', [`+${selectedToolchain}`, 'check', '--locked', '--offline', '--message-format=json', '--manifest-path', manifest,
      '-p', 'polyspec-orm-tests', '--example', id, '--features', selectedFeatures], {
      cwd: root,
      env: isolatedEnvironment({
        ORM_COMPILER_FIXTURE_SOURCE: source,
        CARGO_TARGET_DIR: selectedTarget,
      }),
      stdio,
    });
    const messages: CompilerMessage[] = [];
    let output = '';
    const line = (value: string) => {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isCompilerMessage(parsed)) {
          const message = parsed;
          messages.push(message);
          if (message.message.level === 'error') process.stdout.write(message.message.message + '\n');
        } else if (!isRecord(parsed) || typeof parsed.reason !== 'string' || parsed.reason === '') process.stdout.write(`${value}\n`);
      } catch (error) {
        // A line that is no JSON is the plain output of cargo or rustc, printed as it is.
        if (!(error instanceof SyntaxError)) throw error;
        if (value !== '') process.stdout.write(`${value}\n`);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      output += String(chunk);
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const value of lines) line(value);
    });
    child.stderr.on('data', (chunk: Buffer) => process.stdout.write(String(chunk)));
    child.on('error', rejectRun);
    child.on('close', (status, signal) => {
      if (output !== '') line(output);
      resolveRun({ status, signal, messages });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompilerMessage(value: unknown): value is CompilerMessage {
  if (!isRecord(value) || value.reason !== 'compiler-message' || !isRecord(value.message)) return false;
  const message = value.message;
  if (typeof message.level !== 'string' || typeof message.message !== 'string') return false;
  if (message.code !== undefined && (!isRecord(message.code) || typeof message.code.code !== 'string')) return false;
  if (!Array.isArray(message.spans)) return false;
  return message.spans.every(span => isRecord(span)
    && typeof span.is_primary === 'boolean'
    && typeof span.file_name === 'string'
    && Array.isArray(span.text)
    && span.text.every(line => isRecord(line) && typeof line.text === 'string'));
}

function assertResult(fixture: Fixture, result: Awaited<ReturnType<typeof check>>): void {
  const errors = result.messages.map(value => value.message).filter((value): value is NonNullable<typeof value> => value?.level === 'error');
  if (fixture.expect === 'success') {
    if (result.status !== 0 || result.signal !== null || errors.length !== 0) {
      throw new Error(`${fixture.id}: positive consumer did not compile (exit ${result.status ?? result.signal}); ${errors.map(value => value.message).join('; ')}`);
    }
    console.log(`compiler-fixture: ${fixture.id} passed`);
    return;
  }
  if (result.status === 0 || result.signal !== null) throw new Error(`${fixture.id}: compiler did not reject the negative consumer (exit ${result.status ?? result.signal})`);
  if (errors.length !== 1) throw new Error(`${fixture.id}: expected exactly one compiler error, found ${errors.length}: ${errors.map(value => value.message).join('; ')}`);
  const message = errors[0];
  const code = fixture.code;
  const diagnostic = fixture.diagnostic;
  const sourceLine = fixture.sourceLine;
  if (!message || !code || !diagnostic || !sourceLine) throw new Error(`${fixture.id}: incomplete compiler expectation`);
  const primary = message.spans.find(span => span.is_primary);
  const sourceLines = primary?.text.map(line => line.text) ?? [];
  if (message.code?.code !== code || !message.message.includes(diagnostic)
    || !primary?.file_name.endsWith(`examples/${fixture.id}.rs`) || !sourceLines.some(line => line.includes(sourceLine))) {
    throw new Error(`${fixture.id}: unexpected primary diagnostic: ${JSON.stringify({ code: message.code?.code, message: message.message, file: primary?.file_name, sourceLines })}`);
  }
  console.log(`compiler-fixture: ${fixture.id} passed (${code}, ${diagnostic})`);
}

let madeExamplesDirectory = false;
try {
  try { await mkdir(examples); madeExamplesDirectory = true; } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  for (const fixture of selectedFixtures) {
    const source = join(examples, `${fixture.id}.rs`);
    console.log(`compiler-fixture: running ${fixture.id}`);
    try {
      await writeFile(source, fixture.source, { flag: 'wx' });
      assertResult(fixture, await check(fixture.id, source));
    } finally {
      await rm(source, { force: true });
    }
  }
} finally {
  if (madeExamplesDirectory) await rmdir(examples);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
