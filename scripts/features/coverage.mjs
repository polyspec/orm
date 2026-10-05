import { spawn } from 'node:child_process';
import { endGroup } from '../check/step.mjs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DATABASE, runCase, runLong, stepLines } from '../../tests/testcase.mjs';

// cargoTestScript는 lease 아래에서 test binary를 build하고 복사하는 script다.
const cargoTestScript = new URL('../../tests/cargo-test.mjs', import.meta.url).pathname;
const { programEnvironment } = await import(cargoTestScript);

export const languages = ['go', 'php', 'rust', 'typescript'];
export const databases = ['mysql', 'postgres', 'sqlite'];

const validPart = part => typeof part === 'string' && part !== '' &&
  part.split('/').every(segment => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment));
const validTests = (part, tests) => Array.isArray(tests) && tests.length > 0 &&
  new Set(tests).size === tests.length && tests.every(file =>
    typeof file === 'string' && file.startsWith(part + '/') &&
    file.slice(part.length + 1).split('/').every(segment =>
      segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment)));
const checkerRoot = resolve(new URL('../..', import.meta.url).pathname);

function requirements(feature, errors) {
  const coverage = feature.coverage;
  const required = coverage.kind === 'database' ? databases : ['none'];
  const items = [];
  if (!coverage.owners || typeof coverage.owners !== 'object' || Array.isArray(coverage.owners))
    errors.push(`${feature.id}: missing owners`);
  for (const language of Object.keys(coverage.owners ?? {})) {
    if (!languages.includes(language) || !['pass', 'partial'].includes(feature.clients?.[language]))
      errors.push(`${feature.id}/owner/${language}: undeclared owning client`);
  }
  if (!Array.isArray(coverage.dependents)) errors.push(`${feature.id}: missing dependents declaration`);
  for (const language of languages) {
    if (!['pass', 'partial'].includes(feature.clients?.[language])) continue;
    const owner = coverage.owners?.[language];
    if (!owner || !validPart(owner.part) || !owner.part.startsWith(`clients/${language}/`) && owner.part !== `clients/${language}`) {
      errors.push(`${feature.id}/owner/${language}: missing owning client part`);
      continue;
    }
    if (!validTests(owner.part, owner.tests) || owner.tests.some(file =>
      (Array.isArray(coverage.dependents) ? coverage.dependents : []).some(dependent =>
        dependent?.language === language && typeof dependent.part === 'string' &&
        file.startsWith(dependent.part + '/')))) {
      errors.push(`${feature.id}/owner/${language}: tests must reside in owning part`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/owner/${language}/${database}`,
      role: 'owner', language, database, part: owner.part, tests: owner.tests, cases: coverage.cases,
      command: owner.commands?.[database] });
  }
  const dependentIds = new Set();
  for (const dependent of Array.isArray(coverage.dependents) ? coverage.dependents : []) {
    if (!dependent || typeof dependent.id !== 'string' || !dependent.id || dependentIds.has(dependent.id)) {
      errors.push(`${feature.id}: duplicate or missing dependent id`);
      continue;
    }
    dependentIds.add(dependent.id);
    if (!languages.includes(dependent.language) || !['pass', 'partial'].includes(feature.clients?.[dependent.language]) ||
        !validPart(dependent.part) || dependent.part === 'tests/conformance' ||
        dependent.part.startsWith('tests/conformance/') ||
        dependent.part === coverage.owners?.[dependent.language]?.part ||
        !Array.isArray(dependent.cases) || dependent.cases.length === 0 ||
        new Set(dependent.cases).size !== dependent.cases.length ||
        dependent.cases.some(id => typeof id !== 'string' || !id) ||
        !validTests(dependent.part, dependent.tests) ||
        dependent.tests.some(file => coverage.owners?.[dependent.language]?.tests?.includes(file))) {
      errors.push(`${feature.id}/dependent/${dependent.id}: invalid dependent part, tests, or cases`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/dependent/${dependent.id}/${dependent.language}/${database}`,
      role: 'dependent', dependent: dependent.id, language: dependent.language, database,
      part: dependent.part, tests: dependent.tests, cases: dependent.cases, command: dependent.commands?.[database] });
  }
  // selectFeatures가 coverage 단위(--part)를 골랐으면 그 단위의 항목만 요구하고 실행한다.
  if (selectedParts.has(feature)) return items.filter(item => selectedParts.get(feature).has(itemPart(item)));
  return items;
}

// itemPart는 coverage 항목의 단위 이름이다: owner client는 `owner/<language>`, dependent는 `dependent/<id>`
// (scripts/features/owners.mjs의 coverageParts와 같다).
const itemPart = item => item.role === 'owner' ? `owner/${item.language}` : `dependent/${item.dependent}`;
// selectedParts는 selectFeatures가 만든 기능 항목마다 고른 단위다. manifest의 기능 항목은 바꾸지 않는다.
const selectedParts = new WeakMap();

// Reports in this function are constructed by executeCoverage from native test
// events and the checker's database reader, never parsed from test JSON.
export function checkCoverage(manifest, reports) {
  const errors = [];
  const ids = new Set();
  const expected = new Set();
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
        coverage.cases.some(id => typeof id !== 'string' || !id)) {
      errors.push(`${feature.id}: coverage cases must be distinct nonempty IDs`);
      continue;
    }
    for (const item of requirements(feature, errors)) {
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
              item.tests.some(file => !report.tests.includes(file)))
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
                !value.value_json || !validJSON(value.value_json)))
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
    if (feature.status === 'implemented' && languages.some(language => feature.clients?.[language] !== 'pass'))
      errors.push(`${feature.id}: implemented feature lacks a passing client`);
  }
  for (const key of Object.keys(reports)) {
    if (!expected.has(key)) errors.push(`${key}: undeclared execution report`);
  }
  return errors;
}

function validJSON(value) {
  try { JSON.parse(value); return true; }
  catch { return false; }
}

// run은 program을 실행해 출력을 모은다. step이 있으면 stderr 줄(cargo와 go의 build 진행)을
// 실행 중에 단계로 내보낸다. stdout은 test event이므로 모아서 읽기만 한다.
// run은 program을 실행해 출력을 모은다. step이 있으면 stderr 줄(cargo와 go의 build 진행)을
// 실행 중에 단계로 내보낸다. stdout은 test event이므로 모아서 읽기만 한다. limit은 모으는
// 출력의 최대 길이다. test 출력은 1000000자를 넘지 않고, build의 JSON message는 의존성마다
// 한 줄이라 더 길다. timeoutMs는 실행 process의 기한이고, 장기 작업인 build는 null로 기한 없이 실행한다.
function run(program, args, cwd, timeoutMs, env = process.env, step = undefined, limit = 1_000_000) {
  return new Promise((finish) => {
    const child = spawn(program, args, { cwd, env, detached: true });
    const progress = step ? stepLines(step) : null;
    let output = '';
    let stdout = '';
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ error, value, stdout });
    };
    const append = chunk => {
      output += chunk;
      if (output.length > limit) stop();
    };
    child.stdout.on('data', chunk => { stdout += chunk; append(chunk); });
    child.stderr.on('data', chunk => { append(chunk); progress?.write(String(chunk)); });
    child.on('error', error => done(error.message));
    // child는 자기 group의 leader다. 끝난 뒤 그 group에 남은 process는 실패로 다룬다(endGroup).
    const ended = new Promise(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, error => resolve([`its group could not be checked: ${error.message}`]))));
    child.on('close', async code => {
      progress?.flush();
      const left = await ended;
      if (left.length) return done(`${program} left ${left.length} processes: ${left.join(', ')}`);
      if (output.length > limit) return done(`test output exceeds ${limit} characters`);
      if (code !== 0) return done(`exit ${code}: ${output.trim()}`);
      done(null, output);
    });
    // timeoutMs가 null이면 장기 작업(build)이므로 timer를 두지 않는다.
    const timer = timeoutMs === null ? undefined : setTimeout(() => {
      stop();
      done(`timeout after ${timeoutMs} ms`);
    }, timeoutMs);
  });
}

async function nativeTest(item, command, root) {
  const nativeRunner = command?.runner === 'go' || command?.runner === 'cargo';
  const symbols = command?.symbols;
  const validSymbols = nativeRunner ? Array.isArray(command.cases) &&
    symbols && typeof symbols === 'object' && !Array.isArray(symbols) &&
    Object.keys(symbols).length === command.cases?.length &&
    command.cases?.every(id => Object.hasOwn(symbols, id)) &&
    Object.values(symbols).every(symbol => typeof symbol === 'string' &&
      /^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) &&
    new Set(Object.values(symbols)).size === Object.values(symbols).length : symbols === undefined;
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      !item.tests.includes(command.test) || !Array.isArray(command.cases) ||
      command.cases.length === 0 || new Set(command.cases).size !== command.cases.length ||
      command.cases.some(id => !item.cases.includes(id)) ||
      !['node', 'php', 'go', 'cargo'].includes(command.runner) ||
      (item.language === 'typescript' && command.runner !== 'node') ||
      (item.language === 'php' && command.runner !== 'php') ||
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
      (command.runner === 'go' && extension !== '.go') ||
      (command.runner === 'cargo' && extension !== '.rs'))
    throw new Error('invalid native test file extension');
  if (command.runner === 'node' || command.runner === 'php')
    return { format: 'case', program: command.runner, args: [testPath, ...command.cases] };
  const source = await readFile(testPath, 'utf8');
  const nativeSymbols = command.cases.map(id => symbols[id]);
  for (const symbol of nativeSymbols) {
    const short = symbol.split('::').at(-1);
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

function observedCases(format, output, requested, nativeSymbols = requested) {
  const seen = new Set();
  const add = id => {
    if (seen.has(id)) throw new Error(`duplicate observed case ${id}`);
    seen.add(id);
  };
  if (format === 'case') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const match = /^CASE ([A-Za-z0-9_.-]+) PASS$/.exec(line);
      if (!match) throw new Error(`unexpected test output: ${line}`);
      add(match[1]);
    }
  } else if (format === 'go') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('invalid Go test event'); }
      if (event.Action === 'pass' && event.Test) add(event.Test);
    }
  } else {
    for (const line of output.split(/\r?\n/)) {
      const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/.exec(line);
      if (match) add(match[1]);
    }
  }
  if (seen.size !== nativeSymbols.length || nativeSymbols.some(symbol => !seen.has(symbol)))
    throw new Error(`observed cases ${[...seen].join(',')} differ from ${nativeSymbols.join(',')}`);
  return requested.map(id => ({ id, value_json: 'true' }));
}

// dependencyFiles는 rustc가 test binary 옆에 쓰는 dep-info(<binary>.d)의 첫 규칙에서 그
// binary가 compile한 source file 목록을 읽는다. 경로의 공백은 backslash로 escape되어 있고,
// cargo는 workspace member를 workspace root에 대한 상대 경로로 compile하므로 상대 경로는
// workspace에서 푼다.
async function dependencyFiles(executable, workspace) {
  const text = await readFile(`${executable}.d`, 'utf8');
  const rule = text.split('\n', 1)[0];
  const separator = rule.indexOf(': ');
  if (separator < 0) throw new Error(`dep-info of ${executable} has no rule`);
  return rule.slice(separator + 2).split(/(?<!\\) +/).filter(Boolean).map(path => resolve(workspace, path.replaceAll('\\ ', ' ')));
}

// buildNative는 coverage case보다 먼저 build를 한 번씩 한다. state reader binary, Go
// package마다 `go test -c` test binary와 test2json, Rust crate마다 `cargo test --no-run`의
// test binary다. 두 번의 실행과 모든 database가 같은 binary를 실행한다. build 하나는 장기 작업
// 하나로 시작, 진행(compiler 출력), 종료 코드, 결과와 경과 시간을 보고하고 기한이 없다(runLong). 실패한
// build는 builds의 error로 남고 그 build를 쓰는 실행이 그 error로 실패한다.
async function buildNative(plans, directory) {
  const builds = { state: null, test2json: null, go: new Map(), cargo: new Map() };
  const build = async (name, work) => {
    let failure;
    const passed = await runLong(`features/coverage/build/${name}`, async ({ step }) => {
      try { await work(step); }
      catch (error) { failure = String(error.message); throw error; }
      step('exit 0');
    });
    return passed ? null : failure;
  };
  const go = async (args, cwd, step) => {
    const result = await run('go', args, cwd, null, process.env, step);
    if (result.error) throw new Error(result.error);
  };
  if (plans.some(plan => plan.dsn)) {
    const binary = resolve(directory, 'state');
    const error = await build('state-reader', step => go(['build', '-o', binary, './tests/conformance/check'], checkerRoot, step));
    builds.state = error ? { error } : { binary };
  }
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
  // Rust test binary는 crate가 속한 workspace마다 한 번 build한다. `--workspace`와
  // ORM_RUST_TEST_FEATURES(Makefile)는 client DB test와 다른 Rust 검사가 쓰는 것과 같은 feature
  // 결정을 만들어 그 build를 함께 쓴다. crate 하나만 고르면(`-p`, manifest) feature가 달라져 같은
  // crate를 다시 compile한다.
  const workspaces = new Map();
  for (const crate of new Set(specs.filter(spec => spec.format === 'cargo').map(spec => spec.cwd))) {
    const located = await run('cargo', ['locate-project', '--workspace', '--message-format', 'plain',
      '--manifest-path', resolve(crate, 'Cargo.toml')], crate, null);
    const workspace = located.error ? null : dirname(located.stdout.trim());
    if (!workspace) {
      builds.cargo.set(crate, { error: `cargo locate-project: ${located.error}` });
      continue;
    }
    if (!workspaces.has(workspace)) workspaces.set(workspace, []);
    workspaces.get(workspace).push(crate);
  }
  const features = process.env.ORM_RUST_TEST_FEATURES ? ['--features', process.env.ORM_RUST_TEST_FEATURES] : [];
  const programsOf = new Map();
  for (const [workspace, crates] of workspaces) {
    const files = new Map();
    const error = await build(`cargo/${relative(plans.root, workspace) || '.'}`, async step => {
      // build와 복사는 공유 Rust target directory의 exclusive lease 아래에서 한다(tests/cargo-test.mjs --copy). 실행은
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
      const copied = JSON.parse(await readFile(resolve(copies, 'binaries.json'), 'utf8'));
      programsOf.set(workspace, programEnvironment(copied.programs));
      for (const binary of copied.tests) {
        for (const file of await dependencyFiles(binary.copy, workspace)) {
          if (!files.has(file)) files.set(file, []);
          files.get(file).push(binary.copy);
        }
      }
      step(`${new Set([...files.values()].flat()).size} test binaries`);
    });
    for (const crate of crates) builds.cargo.set(crate, error ? { error } : { files, programs: programsOf.get(workspace) ?? {} });
  }
  return builds;
}

// prepared는 spec 하나를 build된 binary를 실행하는 process 목록으로 바꾼다. Go는 test2json이
// test binary를 실행해 `go test -json`과 같은 event를 낸다. Rust는 선언된 test file을
// compile한 test binary마다 그 entry의 모든 symbol을 한 process에서 정확히 일치로, 선언된 순서와
// 상관없이 하나씩 차례로 실행한다(--test-threads=1). 같은 entry의 case는 같은 database row를 쓸 수
// 있으므로 symbol마다 process를 띄우던 때처럼 겹쳐 실행하지 않는다.
// Rust test binary에는 cargo test처럼 그 crate의 package directory를 CARGO_MANIFEST_DIR로 준다:
// test는 fixture 경로를 실행 시점의 값(orm_testcase::manifest_dir)에서 얻는다.
function prepared(spec, builds) {
  if (spec.format === 'case') return [{ program: spec.program, args: spec.args, cwd: spec.cwd }];
  if (spec.format === 'go') {
    const binary = builds.go.get(spec.cwd);
    if (builds.test2json.error) throw new Error(`go test2json build failed: ${builds.test2json.error}`);
    if (binary.error) throw new Error(`go test build failed: ${binary.error}`);
    return [{ program: builds.test2json.binary, args: ['-t', binary.binary, '-test.v=test2json',
      '-test.count=1', '-test.run', `^(${spec.symbols.join('|')})$`], cwd: spec.cwd, label: `go test ${binary.binary}` }];
  }
  const crate = builds.cargo.get(spec.cwd);
  if (crate.error) throw new Error(`cargo test build failed: ${crate.error}`);
  const executables = crate.files.get(spec.testPath) ?? [];
  if (executables.length === 0) throw new Error(`no test binary compiles ${spec.testPath}`);
  return executables.map(executable => ({ program: executable,
    args: [...spec.symbols, '--exact', '--include-ignored', '--test-threads=1'], cwd: spec.cwd,
    env: { ...crate.programs, CARGO_MANIFEST_DIR: spec.cwd } }));
}

async function state(builds, database, dsn, timeoutMs) {
  if (builds.state.error) throw new Error(`database state reader build failed: ${builds.state.error}`);
  const result = await run(builds.state.binary, ['state', '-driver', database, '-dsn', dsn], checkerRoot, timeoutMs);
  if (result.error) throw new Error(`database state reader: ${result.error.replaceAll(dsn, '[redacted]')}`);
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(result.value);
  if (!match) throw new Error('database state reader returned an invalid digest');
  return match[1];
}

// executeCoverage의 기한이다.
// timeoutMs: 실행 하나가 띄우는 process 하나의 기한이다. process는 build된 binary로, database
// 하나의 catalog digest를 읽는 state reader이거나, 선언된 case를 실행하는 test binary다. 그
// case는 database에 연결해 자기 database를 만들고 지우며 정해진 statement를 실행하므로
// DATABASE 등급(2분)이다. 그 앞의 build는 장기 작업이므로 기한이 없다.
export async function executeCoverage(manifest, root, timeoutMs = DATABASE) {
  const reports = {};
  const errors = [];
  const plans = [];
  plans.root = root;
  for (const feature of manifest.features ?? []) {
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) continue;
    for (const item of requirements(feature, errors)) {
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
          errors.push(`${key}: unavailable part directory: ${error.message}`);
          continue;
        }
        let native;
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
        catch (error) { errors.push(`${key}: ${error.message}`); continue; }
        for (const spec of native) spec.cwd ??= cwd;
        const dsnEnv = command[0].dsn_env;
        const dsn = item.database === 'none' ? null : process.env[dsnEnv];
        if (item.database !== 'none' && !dsn) {
          errors.push(`${key}: missing database DSN in ${dsnEnv}`);
          continue;
        }
        plans.push({ feature, item, native, dsn });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'orm-coverage-'));
  let builds;
  try {
    builds = await buildNative(plans, directory);
    // 실행은 database마다 한 줄(lane)로 차례로 하고, 줄끼리는 함께 진행한다. 한 database의 state는
    // 그 database의 실행만 바꿀 수 있으므로 앞뒤 state 비교는 그대로이고, 세 database와
    // database가 없는 실행이 서로 기다리지 않는다.
    const lanes = Map.groupBy(plans, plan => plan.item.database);
    await Promise.all([...lanes.values()].map(lane => runLane(lane)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return [...errors, ...checkCoverage(manifest, reports)];

  async function runLane(lane) {
    for (const { feature, item, native, dsn } of lane) {
        const { key, command } = item;
        reports[key] = [];
        const testEnv = { ...process.env };
        delete testEnv.ORM_FEATURE_DATABASE;
        delete testEnv.ORM_FEATURE_DSN;
        if (dsn) {
          testEnv.ORM_FEATURE_DATABASE = item.database;
          testEnv.ORM_FEATURE_DSN = dsn;
        }
        let processes;
        try { processes = native.map(spec => prepared(spec, builds)); }
        catch (error) { errors.push(`${key}: ${error.message}`); continue; }
        // 한 실행의 기한은 그 실행이 띄우는 process 기한의 합이다. state reader 두 번과 native
        // process마다 timeoutMs를 가진다.
        const count = (dsn ? 2 : 0) + processes.flat().length;
        for (let attempt = 1; attempt <= 2; attempt++) {
          let failure;
          const passed = await runCase(`${key} run ${attempt}`, count * timeoutMs, async ({ step }) => {
            try {
              const stateBefore = dsn ? await state(builds, item.database, dsn, timeoutMs) : null;
              if (dsn) step(`state before ${stateBefore}`);
              const results = [];
              for (let index = 0; index < native.length; index++) {
                const spec = native[index];
                const entry = command[index];
                let output = '';
                for (const child of processes[index]) {
                  step(child.label ?? `${spec.format === 'case' ? spec.program : child.program} ${entry.test}${spec.symbols ? ` ${spec.symbols.join(' ')}` : ''}`);
                  const result = await run(child.program, child.args, child.cwd, timeoutMs, { ...testEnv, ...child.env }, dsn ? text => step(text.replaceAll(dsn, '[redacted]')) : step);
                  if (result.error) throw new Error(result.error);
                  // libtest는 `test <symbol> ... ok` 결과 줄을 stdout에 쓴다. test가 stderr에 쓰는
                  // case 보고 줄이 그 줄 사이에 끼지 않도록 Rust는 stdout만 읽는다.
                  output += (spec.format === 'cargo' ? result.stdout : result.value) + '\n';
                }
                results.push(...observedCases(spec.format, output, entry.cases, spec.symbols));
              }
              const stateAfter = dsn ? await state(builds, item.database, dsn, timeoutMs) : null;
              if (dsn) step(`state after ${stateAfter}`);
              reports[key].push({ feature: feature.id, role: item.role, language: item.language,
                database: item.database, part: item.part, tests: item.tests, success: true,
                cases: item.cases, results, ...(item.dependent ? { dependent: item.dependent } : {}),
                ...(dsn ? { state_before: stateBefore, state_after: stateAfter } : {}) });
            } catch (error) {
              const message = String(error.message);
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

// selectFeatures는 featureId(check.mjs --feature처럼 contracts/features.json의 id)인 기능 하나만 남긴
// manifest다. parts(`owner/<language>`나 `dependent/<id>`)를 주면 그 coverage 단위만 실행하고 검사한다.
// 없는 id나 단위는 빈 실행이 아니라 고를 수 있는 값을 적은 오류다.
export function selectFeatures(manifest, featureId, parts = []) {
  if (featureId === undefined) {
    if (parts.length) throw new Error('--part needs --feature');
    return manifest;
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
  const pairs = [];
  for (let index = 0; index < args.length; index += 2) pairs.push([args[index], args[index + 1]]);
  if (pairs.some(([flag, value]) => !['--feature', '--part'].includes(flag) || !value) || pairs.filter(([flag]) => flag === '--feature').length > 1)
    throw new Error('usage: coverage.mjs [--feature <id> [--part owner/<language>|dependent/<id>]...]');
  const featureId = pairs.find(([flag]) => flag === '--feature')?.[1];
  const parts = pairs.filter(([flag]) => flag === '--part').map(([, value]) => value);
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(resolve(root, 'contracts/features.json'), 'utf8'));
  let selected;
  try { selected = selectFeatures(manifest, featureId, parts); }
  catch (error) {
    console.error(`feature coverage: ${error.message}`);
    process.exit(2);
  }
  const errors = await executeCoverage(selected, root);
  for (const error of errors) console.error(`feature coverage: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`feature coverage: ${selected.features.length} contracts executed`);
}
