import { spawn } from 'node:child_process';
import { endGroup } from '../check/step.mts';
import { packageDirectory, packageDirectoryOf } from './packages.mts';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PROCESS, runCase, runLong, stepLines } from '../../tests/testcase.mts';
import { errorCode } from '../../tests/errors.mts';
import { readFeatures } from './manifest.mts';
import { parseGoTestEvent } from '../json/formats.mts';
import { programEnvironment, readBinaries } from '../../tests/cargo-test.mts';

// cargoTestScript는 lease 아래에서 test binary를 build하고 복사하는 script다.
const cargoTestScript = new URL('../../tests/cargo-test.mts', import.meta.url).pathname;

/** A native test command of a coverage owner or dependent (contracts/features.json). */
export type NativeCommand = { runner: string; test: string; cases: string[]; dsn_env?: string; symbols?: Record<string, string> };
/** The owning client part of a feature. */
export type Owner = { part: string; tests: string[]; commands?: Record<string, NativeCommand[]> };
/** A dependent part of a feature. */
export type Dependent = { id: string; language: string; part: string; tests: string[]; cases: string[]; commands?: Record<string, NativeCommand[]> };
/** The coverage declaration of a feature. */
export type Coverage = { kind: string; cases: string[]; owners?: Record<string, Owner>; dependents?: Dependent[] };
/** A feature contract of contracts/features.json. */
export type Feature = { id: string; status?: string; clients?: Record<string, string>; coverage?: Coverage; tests?: string[] };
/** The feature manifest, contracts/features.json. */
export type Manifest = { features?: Feature[] };
/** One required execution: an owner or dependent part on one database. */
type Item = { key: string; role: 'owner' | 'dependent'; dependent?: string; language: string; database: string; part: string; tests: string[]; cases: string[]; command: NativeCommand[] | undefined };
/** One observed case result. */
type CaseResult = { id: string; database: string; value_json: string };
/** The report of one execution of an item. */
export type Report = { feature: string; role: string; language: string; database: string; part: string; tests: string[]; success: boolean; cases: string[]; results: CaseResult[]; dependent?: string; state_before?: string | null; state_after?: string | null };
/** The step writer of a running case or build. */
type StepWriter = (text: string) => void;
/** The outcome of run: an error message, or the collected output. */
type RunResult = { error?: string | null | undefined; value?: string | undefined; stdout: string };
/** A native test planned for one execution. */
type Spec = { format: 'case'; program: string; args: string[]; cwd?: string } | { format: 'phpunit'; program: string; args: string[]; cwd: string; symbols: string[] } | { format: 'go'; cwd: string; symbols: string[] } | { format: 'cargo'; cwd: string; testPath: string; symbols: string[] };
/** A build of buildNative: its binary or its error. */
type Built = { binary: string; error?: undefined } | { error: string; binary?: undefined };
/** The Rust builds of a crate. */
type CargoBuilt = { files: Map<string, string[]>; programs: Record<string, string>; error?: undefined } | { error: string; files?: undefined; programs?: undefined };
/** The builds that the executions share. */
type Builds = { test2json: Built | null; go: Map<string, Built>; cargo: Map<string, CargoBuilt>; cargoReady: Promise<void> };
/** The planned executions of one item. */
type Plan = { feature: Feature; item: Item; native: Spec[]; dsn: string | null | undefined };
/** A process of a planned execution. */
type Prepared = { program: string; args: string[]; cwd?: string | undefined; label?: string; env?: Record<string, string> };

export const languages = ['go', 'php', 'python', 'rust', 'typescript'];
// implementedLanguages are the clients that an implemented feature passes in. Python declares its support feature by
// feature (contracts/features.json), so a Python owner is required only where the feature declares Python pass or partial.
export const implementedLanguages = ['go', 'php', 'rust', 'typescript'];
export const databases = ['mysql', 'postgres', 'sqlite'];

const validPart = (part: unknown): part is string => typeof part === 'string' && part !== '' &&
  part.split('/').every(segment => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment));
const validTests = (part: string, tests: unknown): tests is string[] => Array.isArray(tests) && tests.length > 0 &&
  new Set(tests).size === tests.length && tests.every(file =>
    typeof file === 'string' && file.startsWith(part + '/') &&
    file.slice(part.length + 1).split('/').every(segment =>
      segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment)));
const checkerRoot = resolve(new URL('../..', import.meta.url).pathname);
const stateReader = resolve(checkerRoot, 'tests/conformance/check/main.mts');

function requirements(feature: Feature, coverage: Coverage, errors: string[]): Item[] {
  const required = coverage.kind === 'database' ? databases : ['none'];
  const items: Item[] = [];
  if (!coverage.owners || typeof coverage.owners !== 'object' || Array.isArray(coverage.owners))
    errors.push(`${feature.id}: missing owners`);
  for (const language of Object.keys(coverage.owners ?? {})) {
    if (!languages.includes(language) || !['pass', 'partial'].includes(feature.clients?.[language] ?? ''))
      errors.push(`${feature.id}/owner/${language}: undeclared owning client`);
  }
  if (!Array.isArray(coverage.dependents)) errors.push(`${feature.id}: missing dependents declaration`);
  for (const language of languages) {
    if (!['pass', 'partial'].includes(feature.clients?.[language] ?? '')) continue;
    const owner = coverage.owners?.[language];
    const directory = packageDirectoryOf(language);
    if (!owner || !validPart(owner.part) || !owner.part.startsWith(`${directory}/`) && owner.part !== directory) {
      errors.push(`${feature.id}/owner/${language}: missing owning client part`);
      continue;
    }
    if (!validTests(owner.part, owner.tests) || owner.tests.some((file: string) =>
      (Array.isArray(coverage.dependents) ? coverage.dependents : []).some((dependent: Dependent | undefined) =>
        dependent?.language === language && typeof dependent.part === 'string' &&
        file.startsWith(dependent.part + '/')))) {
      errors.push(`${feature.id}/owner/${language}: tests must reside in owning part`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/owner/${language}/${database}`,
      role: 'owner', language, database, part: owner.part, tests: owner.tests, cases: coverage.cases,
      command: owner.commands?.[database] });
  }
  const dependentIds = new Set<string>();
  for (const dependent of Array.isArray(coverage.dependents) ? coverage.dependents : []) {
    if (!dependent || typeof dependent.id !== 'string' || !dependent.id || dependentIds.has(dependent.id)) {
      errors.push(`${feature.id}: duplicate or missing dependent id`);
      continue;
    }
    dependentIds.add(dependent.id);
    if (!languages.includes(dependent.language) || !['pass', 'partial'].includes(feature.clients?.[dependent.language] ?? '') ||
        !validPart(dependent.part) || dependent.part === 'tests/conformance' ||
        dependent.part.startsWith('tests/conformance/') ||
        dependent.part === coverage.owners?.[dependent.language]?.part ||
        !Array.isArray(dependent.cases) || dependent.cases.length === 0 ||
        new Set(dependent.cases).size !== dependent.cases.length ||
        dependent.cases.some((id: unknown) => typeof id !== 'string' || !id) ||
        !validTests(dependent.part, dependent.tests) ||
        dependent.tests.some((file: string) => coverage.owners?.[dependent.language]?.tests?.includes(file))) {
      errors.push(`${feature.id}/dependent/${dependent.id}: invalid dependent part, tests, or cases`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/dependent/${dependent.id}/${dependent.language}/${database}`,
      role: 'dependent', dependent: dependent.id, language: dependent.language, database,
      part: dependent.part, tests: dependent.tests, cases: dependent.cases, command: dependent.commands?.[database] });
  }
  // selectFeatures가 coverage 단위(--part)를 골랐으면 그 단위의 항목만 요구하고 실행한다.
  const selected = selectedParts.get(feature);
  if (selected) return items.filter(item => selected.has(itemPart(item)));
  return items;
}

// itemPart는 coverage 항목의 단위 이름이다: owner client는 `owner/<language>`, dependent는 `dependent/<id>`
// (scripts/features/owners.mts의 coverageParts와 같다).
const itemPart = (item: Item): string => item.role === 'owner' ? `owner/${item.language}` : `dependent/${item.dependent}`;
// selectedParts는 selectFeatures가 만든 기능 항목마다 고른 단위다. manifest의 기능 항목은 바꾸지 않는다.
const selectedParts = new WeakMap<Feature, Set<string>>();

/** One database item of a test file: the database, its DSN variable and the DSN the variable holds (null without a database). */
export type FileItem = { database: string; dsn_env?: string; dsn: string | null };

// coverageItems is the resolver of a test file: every database item the manifest lists for the file (its owner or dependent
// commands on each database), with the DSN its variable holds in env. A test file calls it at startup and runs its cases once
// per item; it never reads the database from the environment of the checker. A file without a database gives one item
// 'none'. A listed DSN variable that is unset fails with its name.
export function coverageItems(manifest: Manifest, file: string, env: NodeJS.ProcessEnv = process.env): FileItem[] {
  const found = new Map<string, { database: string; dsn_env?: string }>();
  const visit = (commands: Record<string, NativeCommand[]> | undefined) => {
    for (const [database, entries] of Object.entries(commands ?? {})) {
      for (const entry of entries ?? []) {
        if (entry?.test !== file) continue;
        const prior = found.get(database);
        if (prior && prior.dsn_env !== entry.dsn_env) throw new Error(`${file} lists ${database} with two DSN variables`);
        found.set(database, { database, ...(entry.dsn_env ? { dsn_env: entry.dsn_env } : {}) });
      }
    }
  };
  for (const feature of manifest.features ?? []) {
    for (const owner of Object.values(feature.coverage?.owners ?? {})) visit(owner.commands);
    for (const dependent of feature.coverage?.dependents ?? []) visit(dependent.commands);
  }
  return [...found.values()].map(item => {
    if (item.database === 'none') return { database: 'none', dsn: null };
    const dsn = env[item.dsn_env ?? ''];
    if (!dsn) throw new Error(`${file}: ${item.database} database DSN is not set in ${item.dsn_env}; run it through make feature-check`);
    return { database: item.database, dsn_env: item.dsn_env, dsn };
  });
}

// Reports in this function are constructed by executeCoverage from native test
// events and the checker's database reader, never parsed from test JSON.
export function checkCoverage(manifest: Manifest, reports: Record<string, Report[] | undefined>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const expected = new Set<string>();
  for (const feature of manifest.features ?? []) {
    if (ids.has(feature.id)) errors.push(`duplicate feature ${feature.id}`);
    ids.add(feature.id);
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) {
      errors.push(`${feature.id}: missing coverage kind`);
      continue;
    }
    if (!Array.isArray(coverage.cases) || coverage.cases.length === 0 ||
        new Set(coverage.cases).size !== coverage.cases.length ||
        coverage.cases.some((id: unknown) => typeof id !== 'string' || !id)) {
      errors.push(`${feature.id}: coverage cases must be distinct nonempty IDs`);
      continue;
    }
    for (const item of requirements(feature, coverage, errors)) {
        const { key, language, database } = item;
        expected.add(key);
        const executions = reports[key];
        if (!executions) { errors.push(`${key}: no executed report`); continue; }
        if (!Array.isArray(executions) || executions.length !== 2) {
          errors.push(`${key}: exactly two executions required`);
          continue;
        }
        for (const report of executions) {
          if (!report || report.feature !== feature.id || report.language !== language || report.database !== database ||
              report.role !== item.role || report.part !== item.part ||
              (item.role === 'dependent' && report.dependent !== item.dependent))
            errors.push(`${key}: report identity differs`);
          if (!Array.isArray(report?.tests) || report.tests.length !== item.tests.length ||
              new Set(report.tests).size !== report.tests.length ||
              item.tests.some((file: string) => !report.tests.includes(file)))
            errors.push(`${key}: executed test paths differ from owning or dependent part`);
          if (report?.success !== true) errors.push(`${key}: execution failed`);
          const seen = report?.cases;
          const values = report?.results;
          if (!Array.isArray(seen) || new Set(seen).size !== seen.length ||
              seen.length !== item.cases.length ||
              item.cases.some(id => !seen.includes(id)) ||
              !Array.isArray(values) || values.length !== item.cases.length ||
              new Set(values.map(value => value.id)).size !== values.length ||
              values.some(value => !seen.includes(value.id) || typeof value.value_json !== 'string' ||
                value.database !== item.database || !value.value_json || !validJSON(value.value_json)))
            errors.push(`${key}: executed case IDs differ from contract`);
          if (coverage.kind === 'database' &&
              (typeof report.state_before !== 'string' || !report.state_before ||
               report.state_before !== report.state_after))
            errors.push(`${key}: database state changed or was not observed`);
        }
        if (!isDeepStrictEqual(executions[0]?.results, executions[1]?.results))
          errors.push(`${key}: results changed on repeated execution`);
        if (coverage.kind === 'database' && executions[0]?.state_before !== executions[1]?.state_before)
          errors.push(`${key}: database state changed between executions`);
    }
    if (feature.status === 'implemented' && implementedLanguages.some(language => feature.clients?.[language] !== 'pass'))
      errors.push(`${feature.id}: implemented feature lacks a passing client`);
  }
  for (const key of Object.keys(reports)) {
    if (!expected.has(key)) errors.push(`${key}: undeclared execution report`);
  }
  return errors;
}

function validJSON(value: string): boolean {
  try { JSON.parse(value); return true; }
  catch { return false; }
}

// run은 program을 실행해 출력을 모은다. step이 있으면 stderr 줄(cargo와 go의 build 진행)을
// 실행 중에 단계로 내보낸다. stdout은 test event이므로 모아서 읽기만 한다.
// run은 program을 실행해 출력을 모은다. step이 있으면 stderr 줄(cargo와 go의 build 진행)을
// 실행 중에 단계로 내보낸다. stdout은 test event이므로 모아서 읽기만 한다. limit은 모으는
// 출력의 최대 길이다. test 출력은 1000000자를 넘지 않고, build의 JSON message는 의존성마다
// 한 줄이라 더 길다. timeoutMs는 실행 process의 기한이고, 장기 작업인 build는 null로 기한 없이 실행한다.
function run(program: string, args: string[], cwd: string | undefined, timeoutMs: number | null, env: NodeJS.ProcessEnv = process.env, step?: StepWriter, limit = 1_000_000): Promise<RunResult> {
  return new Promise<RunResult>((finish) => {
    const child = spawn(program, args, { cwd, env, detached: true });
    const progress = step ? stepLines(step) : null;
    let output = '';
    let stdout = '';
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (errorCode(error) !== 'ESRCH') throw error; }
    };
    const done = (error: string | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ error, value, stdout });
    };
    const append = (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > limit) stop();
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); append(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { append(chunk); progress?.write(String(chunk)); });
    child.on('error', error => done(error.message));
    // child는 자기 group의 leader다. 끝난 뒤 그 group에 남은 process는 실패로 다룬다(endGroup).
    const ended = new Promise<string[]>(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, (error: unknown) => resolve([`its group could not be checked: ${error instanceof Error ? error.message : String(error)}`]))));
    child.on('close', async code => {
      progress?.flush();
      const left = await ended;
      if (left.length) return done(`${program} left ${left.length} processes: ${left.join(', ')}`);
      if (output.length > limit) return done(`test output exceeds ${limit} characters`);
      if (code !== 0) return done(`exit ${code}: ${output.trim()}`);
      done(null, output);
    });
    // timeoutMs가 null이면 장기 작업(build)이므로 timer를 두지 않는다.
    const timer: NodeJS.Timeout | undefined = timeoutMs === null ? undefined : setTimeout(() => {
      stop();
      done(`timeout after ${timeoutMs} ms`);
    }, timeoutMs);
  });
}

async function nativeTest(item: Item, command: NativeCommand, root: string): Promise<Spec> {
  const nativeRunner = command?.runner === 'go' || command?.runner === 'cargo';
  const symbols = command?.symbols;
  const validSymbols = nativeRunner ? Array.isArray(command.cases) &&
    symbols && typeof symbols === 'object' && !Array.isArray(symbols) &&
    Object.keys(symbols).length === command.cases?.length &&
    command.cases?.every((id: string) => Object.hasOwn(symbols, id)) &&
    Object.values(symbols).every(symbol => typeof symbol === 'string' &&
      /^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) &&
    new Set(Object.values(symbols)).size === Object.values(symbols).length : symbols === undefined;
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      !item.tests.includes(command.test) || !Array.isArray(command.cases) ||
      command.cases.length === 0 || new Set(command.cases).size !== command.cases.length ||
      command.cases.some((id: string) => !item.cases.includes(id)) ||
      !['node', 'php', 'python', 'go', 'cargo'].includes(command.runner) ||
      (item.language === 'typescript' && command.runner !== 'node') ||
      (item.language === 'php' && command.runner !== 'php') ||
      (item.language === 'python' && command.runner !== 'python') ||
      (item.language === 'go' && command.runner !== 'go') ||
      (item.language === 'rust' && command.runner !== 'cargo') ||
      (item.database !== 'none' && (typeof command.dsn_env !== 'string' ||
        !/^[A-Z][A-Z0-9_]*$/.test(command.dsn_env) ||
        ['ORM_FEATURE_DATABASE', 'ORM_FEATURE_DSN'].includes(command.dsn_env))) ||
      !validSymbols ||
      Object.keys(command).some(key => !['runner', 'test', 'cases', 'dsn_env', 'symbols'].includes(key)))
    throw new Error('invalid native test command');
  const testPath = resolve(root, command.test);
  if (await realpath(testPath) !== testPath) throw new Error('symbolic test path');
  const extension = extname(testPath);
  if ((command.runner === 'node' && extension !== '.mjs') ||
      (command.runner === 'php' && extension !== '.php') ||
      (command.runner === 'python' && extension !== '.py') ||
      (command.runner === 'go' && extension !== '.go') ||
      (command.runner === 'cargo' && extension !== '.rs'))
    throw new Error('invalid native test file extension');
  if (command.runner === 'node')
    return { format: 'case', program: command.runner, args: [testPath, ...command.cases] };
  // PHP runs on PHPUnit (packages/php/phpunit.xml.dist): a case <id> is the test method test_<id> of the test file's class,
  // selected with an anchored filter and read from the TeamCity events that PHPUnit writes to stdout.
  if (command.runner === 'php') {
    const phpPackage = resolve(root, packageDirectory.php);
    if (!testPath.startsWith(`${phpPackage}/`)) throw new Error(`PHP test ${command.test} is outside ${packageDirectory.php}`);
    return { format: 'phpunit', program: 'php', cwd: root,
      args: [resolve(root, 'vendor-php/bin/phpunit'), '--teamcity', '--configuration', resolve(phpPackage, 'phpunit.xml.dist'),
        '--filter', `/::(${command.cases.map(id => `test_${id}`).join('|')})$/`, testPath],
      symbols: command.cases.map(id => `test_${id}`) };
  }
  // Python runs on the interpreter of the client's venv, which make names in ORM_PYTHON and where the client is installed
  // (Makefile PYTHON_VENV); a python of PATH is not that interpreter.
  if (command.runner === 'python') {
    if (!process.env.ORM_PYTHON) throw new Error('ORM_PYTHON is unset; run this through make, which exports it');
    // The test runs as its module of the package packages/python/tests (`-m packages.python.tests.<name>`) from the
    // checkout root, so it imports its sibling helpers relatively.
    const module = relative(root, testPath).replace(/\.py$/, '').split(sep).join('.');
    return { format: 'case', program: process.env.ORM_PYTHON, args: ['-m', module, ...command.cases], cwd: root };
  }
  const source = await readFile(testPath, 'utf8');
  const nativeSymbols = command.cases.map((id: string) => symbols?.[id] ?? '');
  for (const symbol of nativeSymbols) {
    const short = symbol.split('::').at(-1) ?? '';
    const pattern = command.runner === 'go' ? `\\bfunc\\s+${short}\\s*\\(` : `\\bfn\\s+${short}\\s*\\(`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(short) || !new RegExp(pattern).test(source))
      throw new Error(`test symbol ${symbol} is absent from declared test file`);
  }
  // Go와 Rust는 실행 전에 test binary를 한 번 build한다(buildNative). 여기서는 build 단위만
  // 정한다: Go는 test file의 package directory, Rust는 test file을 소유하는 crate다.
  if (command.runner === 'go')
    return { format: 'go', cwd: dirname(testPath), symbols: nativeSymbols };
  let crate = dirname(testPath);
  while (crate.startsWith(resolve(root, item.part))) {
    try { await realpath(resolve(crate, 'Cargo.toml')); break; }
    catch { crate = dirname(crate); }
  }
  if (!crate.startsWith(resolve(root, item.part))) throw new Error('Rust test has no owning Cargo manifest');
  return { format: 'cargo', cwd: crate, testPath, symbols: nativeSymbols };
}

// observedCases reads the observed cases of one execution of an item on `database` ('none' for an item without a database).
// A case line of a database item is `CASE <id> [<database>] PASS` and a line of an item without one is `CASE <id> PASS`.
// The output of one run may carry the lines of every database of its file (databases lists them); the lines of the other
// databases belong to their own items and are skipped here.
export function observedCases(format: Spec['format'], output: string, requested: string[], nativeSymbols: string[] = requested, database = 'none', databases: string[] = [database]): CaseResult[] {
  const seen = new Set<string>();
  const keys = new Set<string>();
  const add = (id: string, observedDatabase = database) => {
    const key = `${observedDatabase} ${id}`;
    if (keys.has(key)) throw new Error(observedDatabase === 'none' ? `duplicate observed case ${id}` : `duplicate observed case ${id} on ${observedDatabase}`);
    keys.add(key);
    if (observedDatabase === database) seen.add(id);
  };
  if (format === 'case') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const named = /^CASE ([A-Za-z0-9_.-]+) \[([a-z]+)\] PASS$/.exec(line);
      const plain = /^CASE ([A-Za-z0-9_.-]+) PASS$/.exec(line);
      if (database === 'none') {
        if (!plain) throw new Error(`unexpected test output: ${line}`);
        add(plain[1] ?? '');
      } else if (named) {
        if (!databases.includes(named[2] ?? '')) throw new Error(`observed case of database ${named[2]} is not an item of this file: ${line}`);
        if (named[2] === database) add(named[1] ?? '');
        else add(named[1] ?? '', named[2] ?? '');
      } else {
        throw new Error(`unexpected test output: ${line}`);
      }
    }
  } else if (format === 'phpunit') {
    // Each case is testStarted, then testFailed or testIgnored when it did not pass, then testFinished. A case that did not
    // pass, or a finished case that never started, refuses the run.
    const started = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^##teamcity\[(testStarted|testFailed|testIgnored|testFinished) name='([^']*)'/.exec(line);
      if (!match) continue;
      const [, event, name = ''] = match;
      if (event === 'testStarted') {
        if (started.has(name)) throw new Error(`duplicate observed case ${name}`);
        started.add(name);
      } else if (event === 'testFinished') {
        if (!started.has(name)) throw new Error(`case ${name} finished without starting`);
        add(name);
      } else {
        throw new Error(`case ${name} did not pass: ${line}`);
      }
    }
  } else if (format === 'go') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const event = parseGoTestEvent(line, 'go test -json');
      if (event.Action === 'pass' && event.Test) add(event.Test);
    }
  } else {
    for (const line of output.split(/\r?\n/)) {
      const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/.exec(line);
      if (match) add(match[1] ?? '');
    }
  }
  if (seen.size !== nativeSymbols.length || nativeSymbols.some(symbol => !seen.has(symbol))) {
    // 빈 집합은 `observed no cases`로 쓴다. 목록이 비면 `observed cases` 뒤가 비어 보이기 때문이다.
    const observed = seen.size === 0 ? 'observed no cases' : `observed cases ${[...seen].join(',')}`;
    throw new Error(`${observed} differ from ${nativeSymbols.join(',')}`);
  }
  return requested.map(id => ({ id, database, value_json: 'true' }));
}

// dependencyFiles는 rustc가 test binary 옆에 쓰는 dep-info(<binary>.d)의 첫 규칙에서 그
// binary가 compile한 source file 목록을 읽는다. 경로의 공백은 backslash로 escape되어 있고,
// cargo는 workspace member를 workspace root에 대한 상대 경로로 compile하므로 상대 경로는
// workspace에서 푼다.
async function dependencyFiles(executable: string, workspace: string): Promise<string[]> {
  const text = await readFile(`${executable}.d`, 'utf8');
  const rule = text.split('\n', 1)[0] ?? '';
  const separator = rule.indexOf(': ');
  if (separator < 0) throw new Error(`dep-info of ${executable} has no rule`);
  return rule.slice(separator + 2).split(/(?<!\\) +/).filter(Boolean).map(path => resolve(workspace, path.replaceAll('\\ ', ' ')));
}

// buildNative는 coverage case보다 먼저 build를 한 번씩 한다. Go
// package마다 `go test -c` test binary와 test2json, Rust crate마다 `cargo test --no-run`의
// test binary다. 두 번의 실행과 모든 database가 같은 binary를 실행한다. build 하나는 장기 작업
// 하나로 시작, 진행(compiler 출력), 종료 코드, 결과와 경과 시간을 보고하고 기한이 없다(runLong). 실패한
// build는 builds의 error로 남고 그 build를 쓰는 실행이 그 error로 실패한다. Go build는
// 끝난 뒤 돌아오고, 가장 긴 Rust build는 시작만 하고 돌아온다: builds.cargoReady가 그 build가 끝나고
// builds.cargo를 채우면 끝나는 promise다. 그래서 cargo를 쓰지 않는 실행은 Rust build와 함께 진행한다.
/** The plans of one coverage run, with the repository root they resolve against. */
type Plans = Plan[] & { root: string };
/** A build with its name; it returns null when it passes, otherwise its error. */
type Build = (name: string, work: (step: StepWriter) => Promise<void>) => Promise<string | null | undefined>;

async function buildNative(plans: Plans, directory: string): Promise<Builds> {
  const builds: Builds = { test2json: null, go: new Map(), cargo: new Map(), cargoReady: Promise.resolve() };
  const build: Build = async (name, work) => {
    let failure: string | undefined;
    const passed = await runLong(`features/coverage/build/${name}`, async ({ step }) => {
      try { await work(step); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
      step('exit 0');
    });
    return passed ? null : failure;
  };
  const go = async (args: string[], cwd: string, step: StepWriter) => {
    const result = await run('go', args, cwd, null, process.env, step);
    if (result.error) throw new Error(result.error);
  };
  const specs = plans.flatMap(plan => plan.native);
  if (specs.some(spec => spec.format === 'go')) {
    const binary = resolve(directory, 'test2json');
    const error = await build('go/test2json', step => go(['build', '-o', binary, 'cmd/test2json'], checkerRoot, step));
    builds.test2json = error ? { error } : { binary };
  }
  for (const cwd of new Set(specs.filter(spec => spec.format === 'go').map(spec => spec.cwd))) {
    const binary = resolve(directory, `go-${builds.go.size}.test`);
    const error = await build(`go/${relative(plans.root, cwd)}`, step =>
      go(['test', '-c', '-tags', 'featurecoverage', '-o', binary, '.'], cwd, step));
    builds.go.set(cwd, error ? { error } : { binary });
  }
  builds.cargoReady = buildCargo(plans, directory, builds, build);
  return builds;
}

// buildCargo는 Rust test binary의 build다(buildNative). 끝나면 builds.cargo에 crate마다 그 binary나 error를 둔다.
// 실패는 builds.cargo의 error로 남기므로 이 promise는 거부되지 않는다.
async function buildCargo(plans: Plans, directory: string, builds: Builds, build: Build): Promise<void> {
  const specs = plans.flatMap(plan => plan.native);
  // Rust test binary는 crate가 속한 workspace마다 한 번 build한다. `--workspace`와
  // ORM_RUST_TEST_FEATURES(Makefile)는 client DB test와 다른 Rust 검사가 쓰는 것과 같은 feature
  // 결정을 만들어 그 build를 함께 쓴다. crate 하나만 고르면(`-p`, manifest) feature가 달라져 같은
  // crate를 다시 compile한다.
  const workspaces = new Map<string, string[]>();
  for (const crate of new Set(specs.filter(spec => spec.format === 'cargo').map(spec => spec.cwd))) {
    const located = await run('cargo', ['locate-project', '--workspace', '--message-format', 'plain',
      '--manifest-path', resolve(crate, 'Cargo.toml')], crate, null);
    const workspace = located.error ? null : dirname(located.stdout.trim());
    if (!workspace) {
      builds.cargo.set(crate, { error: `cargo locate-project: ${located.error}` });
      continue;
    }
    workspaces.set(workspace, [...(workspaces.get(workspace) ?? []), crate]);
  }
  const features = process.env.ORM_RUST_TEST_FEATURES ? ['--features', process.env.ORM_RUST_TEST_FEATURES] : [];
  const programsOf = new Map<string, Record<string, string>>();
  for (const [workspace, crates] of workspaces) {
    const files = new Map<string, string[]>();
    const error = await build(`cargo/${relative(plans.root, workspace) || '.'}`, async step => {
      // build와 복사는 공유 Rust target directory의 exclusive lease 아래에서 한다(tests/cargo-test.mts --copy). 실행은
      // 이 checker의 directory에 복사한 binary를 쓰므로, 이 checkout의 다른 실행의 build가 target directory를 바꿔도 이
      // 실행의 test binary는 바뀌지 않는다.
      const { LEASE: lease, CARGO_LEASES: leases } = process.env;
      if (!lease || !leases) throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
      const copies = resolve(directory, `cargo-${workspaces.size}-${files.size}-${relative(plans.root, workspace).replaceAll('/', '_') || 'root'}`);
      await mkdir(copies, { recursive: true });
      const result = await run(lease, ['run', leases, 'exclusive', '--wait', '--', process.execPath, cargoTestScript, '--copy', copies, '--',
        'cargo', 'test', '--no-run', '--workspace', ...features, '--manifest-path', resolve(workspace, 'Cargo.toml'),
        '--message-format=json-render-diagnostics'], workspace, null, process.env, step, 100_000_000);
      if (result.error) throw new Error(result.error);
      const copied = readBinaries(copies);
      programsOf.set(workspace, programEnvironment(copied.programs));
      for (const binary of copied.tests) {
        for (const file of await dependencyFiles(binary.copy, workspace)) {
          files.set(file, [...(files.get(file) ?? []), binary.copy]);
        }
      }
      step(`${new Set([...files.values()].flat()).size} test binaries`);
    });
    for (const crate of crates) builds.cargo.set(crate, error ? { error } : { files, programs: programsOf.get(workspace) ?? {} });
  }
}

// prepared는 spec 하나를 build된 binary를 실행하는 process 목록으로 바꾼다. Go는 test2json이
// test binary를 실행해 `go test -json`과 같은 event를 낸다. Rust는 선언된 test file을
// compile한 test binary마다 그 entry의 모든 symbol을 한 process에서 정확히 일치로, 선언된 순서와
// 상관없이 하나씩 차례로 실행한다(--test-threads=1). 같은 entry의 case는 같은 database row를 쓸 수
// 있으므로 symbol마다 process를 띄우던 때처럼 겹쳐 실행하지 않는다.
// Rust test binary에는 cargo test처럼 그 crate의 package directory를 CARGO_MANIFEST_DIR로 준다:
// test는 fixture 경로를 실행 시점의 값(polyspec_orm_testcase::manifest_dir)에서 얻는다.
function prepared(spec: Spec, builds: Builds): Prepared[] {
  if (spec.format === 'case' || spec.format === 'phpunit') return [{ program: spec.program, args: spec.args, cwd: spec.cwd }];
  if (spec.format === 'go') {
    const binary = builds.go.get(spec.cwd);
    const test2json = builds.test2json;
    if (!test2json || test2json.error !== undefined) throw new Error(`go test2json build failed: ${test2json?.error ?? 'it was not built'}`);
    if (!binary || binary.error !== undefined) throw new Error(`go test build failed: ${binary?.error ?? 'it was not built'}`);
    return [{ program: test2json.binary, args: ['-t', binary.binary, '-test.v=test2json',
      '-test.count=1', '-test.run', `^(${spec.symbols.join('|')})$`], cwd: spec.cwd, label: `go test ${binary.binary}` }];
  }
  const crate = builds.cargo.get(spec.cwd);
  if (!crate || crate.error !== undefined) throw new Error(`cargo test build failed: ${crate?.error ?? 'it was not built'}`);
  const executables = crate.files.get(spec.testPath) ?? [];
  if (executables.length === 0) throw new Error(`no test binary compiles ${spec.testPath}`);
  return executables.map((executable: string) => ({ program: executable,
    args: [...spec.symbols, '--exact', '--include-ignored', '--test-threads=1'], cwd: spec.cwd,
    env: { ...crate.programs, CARGO_MANIFEST_DIR: spec.cwd } }));
}

// state is the digest of the database that the state reader (tests/conformance/check/main.mts state) prints.
async function state(database: string, dsn: string, timeoutMs: number): Promise<string> {
  const result = await run(process.execPath, [stateReader, 'state', '--driver', database, '--dsn', dsn], checkerRoot, timeoutMs);
  if (result.error) throw new Error(`database state reader: ${result.error.replaceAll(dsn, '[redacted]')}`);
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(result.value ?? '');
  if (!match?.[1]) throw new Error('database state reader returned an invalid digest');
  return match[1];
}

// usesCargo는 실행이 cargo test binary(buildNative의 Rust build)를 쓰는지다.
const usesCargo = (plan: Plan): boolean => plan.native.some(spec => spec.format === 'cargo');

// executeCoverage의 기한이다.
// timeoutMs: 실행 하나가 띄우는 process 하나의 기한이다. process는 build된 binary로, database
// 하나의 catalog digest를 읽는 state reader이거나, 선언된 case를 실행하는 test binary다. 그
// case는 자기 등급(testcase.Start, caseTest)으로 자기 기한을 지키므로, 이 기한은 멈춘 process를 끝내는 바깥
// 경계이며 선언할 수 있는 가장 긴 등급 PROCESS(5분)보다 짧지 않다. 그 앞의 build는 장기 작업이므로 기한이 없다.
export const NATIVE_DEADLINE = PROCESS;
export async function executeCoverage(manifest: Manifest, root: string, timeoutMs = NATIVE_DEADLINE): Promise<string[]> {
  const reports: Record<string, Report[]> = {};
  const errors: string[] = [];
  const plans: Plans = Object.assign([] as Plan[], { root });
  for (const feature of manifest.features ?? []) {
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) continue;
    for (const item of requirements(feature, coverage, errors)) {
        const { key, command } = item;
        if (!command) {
          errors.push(`${key}: no executable command`);
          continue;
        }
        const cwd = resolve(root, item.part);
        if (!cwd.startsWith(resolve(root) + '/')) {
          errors.push(`${key}: invalid part directory`);
          continue;
        }
        try {
          if (await realpath(cwd) !== cwd) throw new Error('symbolic path');
          for (const file of item.tests) {
            const target = resolve(root, file);
            if (await realpath(target) !== target) throw new Error(`symbolic test path ${file}`);
          }
        } catch (error) {
          errors.push(`${key}: unavailable part directory: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        let native: Spec[];
        try {
          if (!Array.isArray(command) || command.length !== item.tests.length ||
              new Set(command.map(entry => entry?.test)).size !== item.tests.length ||
              item.tests.some(test => !command.some(entry => entry?.test === test)) ||
              command.flatMap(entry => entry?.cases ?? []).length !== item.cases.length ||
              new Set(command.flatMap(entry => entry?.cases ?? [])).size !== item.cases.length ||
              item.cases.some(id => !command.some(entry => entry?.cases?.includes(id))) ||
              (item.database !== 'none' && new Set(command.map(entry => entry?.dsn_env)).size !== 1))
            throw new Error('invalid native test command');
          native = await Promise.all(command.map(entry => nativeTest(item, entry, root)));
        }
        catch (error) { errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        for (const spec of native) if (spec.format === 'case') spec.cwd ??= cwd;
        const dsnEnv = command[0]?.dsn_env ?? '';
        const dsn = item.database === 'none' ? null : process.env[dsnEnv];
        if (item.database !== 'none' && !dsn) {
          errors.push(`${key}: missing database DSN in ${dsnEnv}`);
          continue;
        }
        plans.push({ feature, item, native, dsn });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'orm-coverage-'));
  let builds: Builds | undefined;
  try {
    builds = await buildNative(plans, directory);
    // 실행은 database마다 한 줄(lane)로 차례로 하고, 줄끼리는 함께 진행한다. 한 database의 state는
    // 그 database의 실행만 바꿀 수 있으므로 앞뒤 state 비교는 그대로이고, 세 database와
    // database가 없는 실행이 서로 기다리지 않는다. 줄 안에서는 cargo를 쓰지 않는 실행이 먼저, Rust build
    // 동안 진행하고, cargo test binary를 쓰는 실행이 그 build가 끝난 뒤 manifest의 순서대로 온다.
    // 실행마다 자기 앞뒤 state를 비교하므로 실행의 순서는 결과를 바꾸지 않는다.
    // A file that lists several databases runs once for them (runUnit), before the lanes; the other plans run in lanes.
    const units = groupUnits(plans);
    for (const unit of units) if (unit.length > 1) await runUnit(unit);
    const singles = units.filter(unit => unit.length === 1).map(unit => unit[0] ?? null).filter((plan): plan is Plan => plan !== null);
    const lanes = Map.groupBy(singles, plan => plan.item.database);
    await Promise.all([...lanes.values()].map(lane => runLane([...lane.filter(plan => !usesCargo(plan)), ...lane.filter(usesCargo)])));
  } finally {
    // 임시 directory를 지우기 전에 Rust build(그 directory에 binary를 복사한다)가 끝나기를 기다린다.
    await builds?.cargoReady;
    await rm(directory, { recursive: true, force: true });
  }
  return [...errors, ...checkCoverage(manifest, reports)];

  // runUnit runs one file of several databases once per attempt. The file prints the cases of every database, and each plan
  // takes the lines of its own database. The state of each database is read before and after that one run.
  async function runUnit(unit: Plan[]): Promise<void> {
    const first = unit[0];
    const shared = builds;
    if (!first || !shared || !first.item.command) return;
    for (const plan of unit) reports[plan.item.key] = [];
    const databases = unit.map(plan => plan.item.database);
    let processes: Prepared[][];
    try { processes = first.native.map(spec => prepared(spec, shared)); }
    catch (error) {
      for (const plan of unit) errors.push(`${plan.item.key}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const count = unit.length * 2 + processes.flat().length;
    const dsns = unit.map(plan => plan.dsn ?? '');
    for (let attempt = 1; attempt <= 2; attempt++) {
      let failure: string | undefined;
      // A state reader failure belongs to its own database: each item reports its own, and the run stops before the file runs.
      const planFailures = new Map<string, string>();
      const readStates = async (): Promise<(string | null)[]> => {
        const readings: (string | null)[] = [];
        for (const plan of unit) {
          try { readings.push(await state(plan.item.database, plan.dsn ?? '', timeoutMs)); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            planFailures.set(plan.item.key, dsns.reduce((text, dsn) => (dsn ? text.replaceAll(dsn, '[redacted]') : text), message));
            readings.push(null);
          }
        }
        return readings;
      };
      const passed = await runCase(`${first.item.key} (${databases.join(',')}) run ${attempt}`, count * timeoutMs, async ({ step }) => {
        try {
          const before = await readStates();
          if (planFailures.size) throw new Error('database state reader failed');
          unit.forEach((plan, index) => step(`state before ${before[index]} ${plan.item.database}`));
          let output = '';
          for (const child of processes.flat()) {
            step(child.label ?? `${child.program} ${first.item.key}`);
            const result = await run(child.program, child.args, child.cwd, timeoutMs, { ...process.env, ...child.env }, step);
            if (result.error) throw new Error(result.error);
            output += `${result.value}\n`;
          }
          const after = await readStates();
          if (planFailures.size) throw new Error('database state reader failed');
          unit.forEach((plan, index) => step(`state after ${after[index]} ${plan.item.database}`));
          const pending = unit.map((plan, index) => {
            const entry = plan.item.command?.[0];
            if (!entry) throw new Error(`no native test for ${plan.item.key}`);
            const results = observedCases('case', output, entry.cases, entry.cases, plan.item.database, databases);
            return { plan, results, before: before[index] ?? null, after: after[index] ?? null };
          });
          for (const { plan, results, before: stateBefore, after: stateAfter } of pending) {
            const item = plan.item;
            reports[item.key]?.push({ feature: plan.feature.id, role: item.role, language: item.language,
              database: item.database, part: item.part, tests: item.tests, success: true,
              cases: item.cases, results, ...(item.dependent ? { dependent: item.dependent } : {}),
              state_before: stateBefore, state_after: stateAfter });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failure = dsns.reduce((text, dsn) => (dsn ? text.replaceAll(dsn, '[redacted]') : text), message);
          throw new Error(failure);
        }
      });
      if (!passed) {
        for (const plan of unit) {
          errors.push(`${plan.item.key} run ${attempt}: ${planFailures.get(plan.item.key) ?? failure ?? `deadline ${count * timeoutMs} ms exceeded`}`);
        }
        break;
      }
    }
  }

  async function runLane(lane: Plan[]): Promise<void> {
    for (const plan of lane) {
        const { feature, item, native, dsn } = plan;
        const { key, command } = item;
        if (usesCargo(plan)) await builds?.cargoReady;
        const shared = builds;
        if (!shared || !command) continue;
        const executions: Report[] = [];
        reports[key] = executions;
        const testEnv = { ...process.env };
        delete testEnv.ORM_FEATURE_DATABASE;
        delete testEnv.ORM_FEATURE_DSN;
        if (dsn) {
          testEnv.ORM_FEATURE_DATABASE = item.database;
          testEnv.ORM_FEATURE_DSN = dsn;
        }
        let processes: Prepared[][];
        try { processes = native.map(spec => prepared(spec, shared)); }
        catch (error) { errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        // 한 실행의 기한은 그 실행이 띄우는 process 기한의 합이다. state reader 두 번과 native
        // process마다 timeoutMs를 가진다.
        const count = (dsn ? 2 : 0) + processes.flat().length;
        for (let attempt = 1; attempt <= 2; attempt++) {
          let failure: string | undefined;
          const passed = await runCase(`${key} run ${attempt}`, count * timeoutMs, async ({ step }) => {
            try {
              const stateBefore = dsn ? await state(item.database, dsn, timeoutMs) : null;
              if (dsn) step(`state before ${stateBefore}`);
              const results: CaseResult[] = [];
              for (let index = 0; index < native.length; index++) {
                const spec = native[index];
                const entry = command[index];
                if (!spec || !entry) throw new Error(`no native test ${index}`);
                let output = '';
                for (const child of processes[index] ?? []) {
                  step(child.label ?? `${spec.format === 'case' || spec.format === 'phpunit' ? spec.program : child.program} ${entry.test}${spec.format !== 'case' ? ` ${spec.symbols.join(' ')}` : ''}`);
                  const result = await run(child.program, child.args, child.cwd, timeoutMs, { ...testEnv, ...child.env }, dsn ? (text: string) => step(text.replaceAll(dsn, '[redacted]')) : step);
                  if (result.error) throw new Error(result.error);
                  // libtest는 `test <symbol> ... ok` 결과 줄을, PHPUnit은 TeamCity event를 stdout에 쓴다. test가
                  // stderr에 쓰는 줄이 그 사이에 끼지 않도록 Rust와 PHP는 stdout만 읽는다.
                  output += (spec.format === 'cargo' || spec.format === 'phpunit' ? result.stdout : result.value) + '\n';
                }
                results.push(...observedCases(spec.format, output, entry.cases, spec.format === 'case' ? entry.cases : spec.symbols, item.database));
              }
              const stateAfter = dsn ? await state(item.database, dsn, timeoutMs) : null;
              if (dsn) step(`state after ${stateAfter}`);
              executions.push({ feature: feature.id, role: item.role, language: item.language,
                database: item.database, part: item.part, tests: item.tests, success: true,
                cases: item.cases, results, ...(item.dependent ? { dependent: item.dependent } : {}),
                ...(dsn ? { state_before: stateBefore, state_after: stateAfter } : {}) });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failure = dsn ? message.replaceAll(dsn, '[redacted]') : message;
              throw new Error(failure);
            }
          });
          if (!passed) {
            errors.push(`${key} run ${attempt}: ${failure ?? `deadline ${count * timeoutMs} ms exceeded`}`);
            break;
          }
        }
    }
  }
}

// groupUnits puts the plans of one file that run the same case command on several databases into one unit (runUnit);
// every other plan is a unit of its own.
function groupUnits(plans: Plan[]): Plan[][] {
  const units: Plan[][] = [];
  const byFile = new Map<string, Plan[]>();
  for (const plan of plans) {
    const spec = plan.native[0];
    const groupable = plan.native.length === 1 && spec?.format === 'case' && plan.item.database !== 'none' && Boolean(plan.dsn);
    if (!groupable || !spec || spec.format !== 'case') {
      units.push([plan]);
      continue;
    }
    const key = `${plan.item.language}\0${JSON.stringify(spec.args)}`;
    const unit = byFile.get(key);
    if (unit && !unit.some(other => other.item.database === plan.item.database)) unit.push(plan);
    else if (unit) units.push([plan]);
    else {
      const created = [plan];
      byFile.set(key, created);
      units.push(created);
    }
  }
  return units;
}

// selectFeatures는 featureId(check.mts --feature처럼 contracts/features.json의 id)인 기능 하나만 남긴
// manifest다. parts(`owner/<language>`나 `dependent/<id>`)를 주면 그 coverage 단위만 실행하고 검사한다.
// 없는 id나 단위는 빈 실행이 아니라 고를 수 있는 값을 적은 오류다.
export function selectFeatures(manifest: Manifest, featureId: string | undefined, parts: string[] = []): Manifest & { features: Feature[] } {
  if (featureId === undefined) {
    if (parts.length) throw new Error('--part needs --feature');
    return { ...manifest, features: manifest.features ?? [] };
  }
  const feature = manifest.features?.find(item => item.id === featureId);
  if (!feature)
    throw new Error(`unknown feature ${featureId}; valid features: ${(manifest.features ?? []).map(item => item.id).join(', ')}`);
  if (parts.length === 0) return { ...manifest, features: [feature] };
  const valid = [...Object.keys(feature.coverage?.owners ?? {}).map(language => `owner/${language}`),
    ...(feature.coverage?.dependents ?? []).map(dependent => `dependent/${dependent.id}`)];
  const unknown = parts.filter(part => !valid.includes(part));
  if (unknown.length) throw new Error(`unknown coverage part ${unknown.join(', ')} of ${featureId}; valid parts: ${valid.join(', ')}`);
  const copy = { ...feature };
  selectedParts.set(copy, new Set(parts));
  return { ...manifest, features: [copy] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  // `--items <test file>` prints the coverage items of the file as JSON (coverageItems); the Python test files call it.
  if (args[0] === '--items' && args.length === 2) {
    const root = resolve(new URL('../..', import.meta.url).pathname);
    console.log(JSON.stringify(coverageItems(readFeatures(root), args[1] ?? '')));
    process.exit(0);
  }
  const pairs: [string | undefined, string | undefined][] = [];
  for (let index = 0; index < args.length; index += 2) pairs.push([args[index], args[index + 1]]);
  if (pairs.some(([flag, value]) => !['--feature', '--part'].includes(flag ?? '') || !value) || pairs.filter(([flag]) => flag === '--feature').length > 1)
    throw new Error('usage: coverage.mts [--feature <id> [--part owner/<language>|dependent/<id>]...]');
  const featureId = pairs.find(([flag]) => flag === '--feature')?.[1];
  const parts = pairs.filter(([flag]) => flag === '--part').map(([, value]) => value ?? '');
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const manifest: Manifest = readFeatures(root);
  let selected: Manifest & { features: Feature[] };
  try { selected = selectFeatures(manifest, featureId, parts); }
  catch (error) {
    console.error(`feature coverage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const errors = await executeCoverage(selected, root);
  for (const error of errors) console.error(`feature coverage: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`feature coverage: ${selected.features.length} contracts executed`);
}
