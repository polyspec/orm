// owners는 바뀐 file의 owner check를 고르고 실행한다(AGENTS.md "Owner checks").
//
//   node scripts/features/owners.mjs [--list] [<path>...]
//
// path가 없으면 HEAD에서 바뀐 file과 추적하지 않는 file이다. contracts/features.json의 검증 명령은
// `inputs`를, coverage 단위(owner client와 dependent)는 `tests`와 `inputs`를 선언하고, 바뀐 path가 그 입력이거나
// 선언한 fixture data가 적는 file이면 그 명령과 단위만 고른다. 여러 기능이 쓰는 helper(`helpers`)는 어떤
// 입력도 아니며, 그 변경은 helper 자신의 check만 실행한다. 그 helper를 쓰는 모든 기능의 실행은 make check가
// 맡는다. contracts/features.json이 바뀌면 HEAD의 manifest와 달라진 기능과 helper 항목을 고른다.
// 고른 명령은 features/check.mjs --run --feature <id> --command <id>, 단위는 features/coverage.mjs --feature <id>
// --part <part>, helper는 features/check.mjs --run --helper <id>로 실행하고 RUN, STEP, PASS, FAIL과 경과 시간을
// 보고한다. 기한은 그 안의 case마다 있고, 단계 전체에 거는 기한은 없다.
// 또 contracts/check-inputs.json이 scope owner로 선언한 make target 중 입력이 바뀐 path를 맞추는
// target(예: docs/*.md에 docs-check와 docs-verify-idempotent)을 먼저 실행한다. scope suite인 target은
// 전체 suite(make check)에서만 실행하고 여기서는 고르지 않는다. scope나 입력 선언이 규칙과 다르면
// 아무것도 실행하지 않고 실패한다.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runGroup, stepLines } from '../../tests/testcase.mjs';
import { makeRecipes } from '../repo/testcases.mjs';
import { NEEDS } from '../check/ci-setup.mjs';

// fixture text 안의 repository path다. 확장자가 있는 상대 path만 본다.
const pathPattern = /(?:contracts|tests|schema|clients|engine)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

// namedPaths는 선언한 fixture file이 적는 repository path다. 없는 path는 버린다.
async function namedPaths(root, fixture) {
  let text;
  try { text = await readFile(resolve(root, fixture), 'utf8'); } catch { return []; }
  return [...new Set(text.match(pathPattern) ?? [])].filter(p => p !== fixture && existsSync(resolve(root, p)));
}

// manifestChanges는 previous(HEAD의 contracts/features.json)와 current 사이에서 항목이 달라졌거나 새로
// 생긴 기능과 helper의 id를 current 순서로 돌려준다. whole은 기능과 helper 항목 밖의 field가 달라졌거나
// 기능이 사라졌거나 previous가 없다는 뜻이다. 그런 변경은 한 기능의 것이 아니므로 전체 suite가 검사한다.
export function manifestChanges(previous, current) {
  const changed = key => {
    const before = new Map((previous?.[key] ?? []).map(item => [item.id, item]));
    return (current[key] ?? []).filter(item => !isDeepStrictEqual(before.get(item.id), item)).map(item => item.id);
  };
  const outside = manifest => Object.fromEntries(Object.entries(manifest ?? {}).filter(([key]) => key !== 'features' && key !== 'helpers'));
  const ids = new Set((current.features ?? []).map(feature => feature.id));
  const whole = !previous || !isDeepStrictEqual(outside(previous), outside(current)) || (previous.features ?? []).some(feature => !ids.has(feature.id));
  return { features: changed('features'), helpers: changed('helpers'), whole };
}

// coverageParts는 기능의 coverage 단위(owner client마다 `owner/<language>`, dependent마다
// `dependent/<id>`)와 그 test, 입력이다. coverage.mjs --part가 같은 이름으로 그 단위만 실행한다.
export function coverageParts(feature) {
  const coverage = feature.coverage ?? {};
  return [
    ...Object.entries(coverage.owners ?? {}).map(([language, owner]) => ({ part: `owner/${language}`, tests: owner.tests ?? [], inputs: owner.inputs ?? [] })),
    ...(coverage.dependents ?? []).map(dependent => ({ part: `dependent/${dependent.id}`, tests: dependent.tests ?? [], inputs: dependent.inputs ?? [] })),
  ];
}

// inputMatcher는 선언한 입력 pattern과, 선언한 fixture data file(JSON, dbspec 문서)이 적는 file(예:
// contracts/fixtures/schema_definition.json이 렌더링하는 contracts/fixtures/audit.dbs, contracts/symbols/rust.json이
// 적는 Rust source)을 맞추는 함수를 돌려준다. 적힌 file이 다시 적는 file은 따라가지 않는다: 그 단위가
// 선언한 data만 그 단위의 입력이다. source code의 주석과 문자열은 입력 선언이 아니다. 맞추면 이유(path나
// "<path> (named by <input>)")를, 아니면 undefined를 돌려준다.
async function inputMatcher(root, patterns) {
  const globs = patterns.map(pattern => globPattern(pattern));
  const named = new Map();
  for (const input of patterns.filter(pattern => !pattern.includes('*') && /\.(?:json|dbs)$/.test(pattern) && pattern !== 'contracts/features.json'))
    for (const path of await namedPaths(root, input))
      if (!named.has(path) && !patterns.includes(path)) named.set(path, input);
  return path => {
    if (globs.some(pattern => pattern.test(path))) return path;
    if (named.has(path)) return `${path} (named by ${named.get(path)})`;
    return undefined;
  };
}

// selectOwners는 changed(repository 상대 path)가 입력인 기능의 검증 명령과 coverage 단위를 manifest
// 순서로 돌려준다: [{ feature, commands: [{ id, reasons }], parts: [{ part, reasons }] }]. 검증 명령의 입력은
// 그 `inputs`, coverage 단위의 입력은 그 `tests`와 `inputs`다. changed에 contracts/features.json이 있으면
// change(manifestChanges의 결과)가 적는 기능의 명령과 단위를 모두 "contracts/features.json (entry of <id>)"로
// 고른다. helper(manifest.helpers)는 어떤 명령이나 단위의 입력도 아니므로 기능을 고르지 않는다.
export async function selectOwners(manifest, root, changed, change) {
  const out = [];
  for (const feature of manifest.features) {
    const entry = changed.includes('contracts/features.json') && change?.features.includes(feature.id)
      ? [`contracts/features.json (entry of ${feature.id})`] : [];
    const select = async patterns => {
      const match = await inputMatcher(root, patterns);
      return [...changed.map(match).filter(Boolean), ...entry];
    };
    const commands = [];
    for (const check of feature.verification ?? []) {
      const reasons = await select(check.inputs ?? []);
      if (reasons.length) commands.push({ id: check.id, reasons });
    }
    const parts = [];
    for (const { part, tests, inputs } of coverageParts(feature)) {
      const reasons = await select([...tests, ...inputs]);
      if (reasons.length) parts.push({ part, reasons });
    }
    if (commands.length || parts.length) out.push({ feature, commands, parts });
  }
  return out;
}

// selectHelpers는 changed가 path인 helper(manifest.helpers)와 그 이유를 돌려준다. helper의 변경은 그
// helper의 check만 실행하고, helper를 쓰는 모든 기능의 실행은 전체 suite(make check)가 맡는다.
export async function selectHelpers(manifest, root, changed, change) {
  const out = [];
  for (const helper of manifest.helpers ?? []) {
    const match = await inputMatcher(root, [...helper.paths, ...(helper.tests ?? [])]);
    const reasons = changed.map(match).filter(Boolean);
    if (changed.includes('contracts/features.json') && change?.helpers?.includes(helper.id)) reasons.push(`contracts/features.json (entry of ${helper.id})`);
    if (reasons.length) out.push({ helper, reasons });
  }
  return out;
}

// manifestInputErrors는 contracts/features.json의 입력 선언이 규칙과 다른 곳마다 오류 하나를 돌려준다.
//   - 모든 검증 명령은 비어 있지 않은 `inputs`를 선언하고, 모든 pattern은 추적되는 file을 맞춘다.
//   - coverage 단위의 `inputs`(있으면)도 추적되는 file을 맞추는 pattern이다.
//   - helper는 id, 추적되는 `paths`, 추적되는 `tests`, `command`를 가진다. helper의 path는 어떤 검증 명령이나
//     coverage 단위의 입력도 아니다: 그렇다면 helper 하나가 그것을 쓰는 모든 기능을 고른다.
export function manifestInputErrors(manifest, tracked) {
  const errors = [];
  const matches = pattern => {
    const regex = globPattern(pattern);
    return tracked.some(path => regex.test(path));
  };
  const checkPatterns = (where, patterns) => {
    for (const pattern of patterns)
      if (typeof pattern !== 'string' || !matches(pattern)) errors.push(`${where}: input ${pattern} matches no tracked file`);
  };
  const owners = [];
  for (const feature of manifest.features ?? []) {
    for (const check of feature.verification ?? []) {
      const where = `contracts/features.json ${feature.id}/${check.id}`;
      if (!Array.isArray(check.inputs) || check.inputs.length === 0) errors.push(`${where} declares no inputs; declare the files whose change runs it`);
      else checkPatterns(where, check.inputs);
      owners.push([where, check.inputs ?? []]);
    }
    for (const { part, tests, inputs } of coverageParts(feature)) {
      const where = `contracts/features.json ${feature.id}/coverage/${part}`;
      checkPatterns(where, inputs);
      owners.push([where, [...tests, ...inputs]]);
    }
  }
  const helperIds = new Set();
  for (const [index, helper] of (manifest.helpers ?? []).entries()) {
    const where = `contracts/features.json helper ${helper?.id ?? index}`;
    if (typeof helper?.id !== 'string' || !helper.id || helperIds.has(helper.id)) errors.push(`${where}: duplicate or missing id`);
    helperIds.add(helper?.id);
    if (typeof helper?.command !== 'string' || !helper.command) errors.push(`${where}: missing command`);
    if (!Array.isArray(helper?.paths) || helper.paths.length === 0) errors.push(`${where}: declares no paths`);
    if (!Array.isArray(helper?.tests)) errors.push(`${where}: declares no tests list`);
    checkPatterns(where, [...(helper?.paths ?? []), ...(helper?.tests ?? [])]);
    for (const path of tracked.filter(file => (helper?.paths ?? []).some(pattern => globPattern(pattern).test(file))))
      for (const [owner, patterns] of owners)
        if (patterns.some(pattern => globPattern(pattern).test(path)))
          errors.push(`${owner} declares ${path} of ${where} as an input; a helper runs only its own check`);
  }
  return errors;
}

// globPattern은 contracts/check-inputs.json의 pattern을 정규식으로 바꾼다: `*`는 path 한 단계 안,
// `**`는 여러 단계를 맞춘다.
function globPattern(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const scopes = ['owner', 'suite'];
const scopeError = target => `contracts/check-inputs.json declares no scope of ${target}; declare owner or suite`;

// selectTargets는 declared(contracts/check-inputs.json의 targets)에서 scope owner이고 입력 pattern(inputs)이나
// 형식 검사 pattern(lints)이 changed path를 맞추는 make target과 그 path를 선언 순서로 돌려준다. tested는 그
// 가운데 inputs가 맞춘 path다: target이 그 path의 행동을 시험한다. lints만 맞춘 path는 형식만 검사받는다(go
// vet, gofmt, 문서 규칙 같은 것). scope를 선언하지 않은 target이 있으면 던진다.
export function selectTargets(declared, changed) {
  const out = [];
  for (const [target, declaration] of Object.entries(declared))
    if (!scopes.includes(declaration?.scope)) throw new Error(scopeError(target));
  for (const [target, { scope, inputs, lints }] of Object.entries(declared)) {
    if (scope !== 'owner') continue;
    const behaviour = (inputs ?? []).map(globPattern);
    const format = (lints ?? []).map(globPattern);
    const tested = changed.filter(path => behaviour.some(pattern => pattern.test(path)));
    const reasons = changed.filter(path => tested.includes(path) || format.some(pattern => pattern.test(path)));
    if (reasons.length) out.push({ target, reasons, tested });
  }
  return out;
}

// pathScopes는 행동 시험이 없는 path의 선언(contracts/check-inputs.json의 paths)이다. 정확한 path마다 scope와
// 이유를 둔다: lint는 본성상 형식 검사만 있는 file(LICENSE, rustfmt 설정 같은 것), suite는 그 효과가 suite
// 전체에 미쳐 owner-check가 부분을 고를 수 없는 file(lockfile, toolchain 고정, workflow, 여러 target이 쓰는
// test 기반)이며 그 시험은 make check가 맡는다.
const pathScopeKinds = ['lint', 'suite'];
export function pathScopeErrors(paths, tracked) {
  const errors = [];
  for (const [path, declaration] of Object.entries(paths ?? {})) {
    if (/[*?[]/.test(path)) errors.push(`contracts/check-inputs.json paths: ${path} is a pattern; declare each path`);
    else if (!tracked.includes(path)) errors.push(`contracts/check-inputs.json paths: ${path} is not a tracked file`);
    if (!pathScopeKinds.includes(declaration?.scope)) errors.push(`contracts/check-inputs.json paths: ${path} declares scope ${declaration?.scope}; declare lint or suite`);
    if (typeof declaration?.reason !== 'string' || declaration.reason.trim() === '') errors.push(`contracts/check-inputs.json paths: ${path} declares no reason`);
  }
  return errors;
}

// untestedPaths는 changed 가운데 어떤 기능 검사, coverage 단위, helper도 고르지 않고, 어떤 make target도 그
// inputs로 고르지 않으며, paths에 scope를 선언하지 않은 path다. owner-check는 이것이 있으면 실패한다: 그 path의
// 변경은 owner-check로 시험되지 않는다. 지운 path는 시험할 것이 없으므로 들지 않는다.
export function untestedPaths(changed, { owners, helpers, targets, paths, exists }) {
  const reasonsOf = item => item.reasons;
  const tested = new Set([
    ...owners.flatMap(owner => [...owner.commands, ...owner.parts].flatMap(reasonsOf)),
    ...helpers.flatMap(reasonsOf),
  ].map(reason => reason.split(' (')[0]));
  for (const { tested: paths } of targets) for (const path of paths ?? []) tested.add(path);
  return changed.filter(path => !tested.has(path) && !Object.hasOwn(paths ?? {}, path) && exists(path));
}

// checkInputErrors는 declared가 CHECK_TARGETS의 target에 scope(owner나 suite)나 needs(필요한 setup 단계)를
// 선언하지 않거나,
// CHECK_TARGETS에 없는 target을 선언하거나, owner target에 입력이 없거나, suite target에 쓰이지 않을
// 입력이 있거나, pattern이 추적되는 file을 하나도 맞추지 않는 곳마다 오류 하나를 돌려준다.
export function checkInputErrors(declared, targets, tracked) {
  const errors = [];
  for (const target of targets)
    if (!scopes.includes(declared[target]?.scope))
      errors.push(`contracts/check-inputs.json declares no scope of ${target} of CHECK_TARGETS`);
  for (const [target, declaration] of Object.entries(declared)) {
    if (!targets.includes(target)) errors.push(`contracts/check-inputs.json declares ${target}, which is not in CHECK_TARGETS`);
    // needs는 target이 필요한 setup 단계다. runner(scripts/check/run.mjs)는 그 단계가 실패하면 target을 not-run으로 기록한다.
    const needs = declaration?.needs;
    if (!Array.isArray(needs)) errors.push(`contracts/check-inputs.json declares no needs of ${target}; declare [] or the setup it needs (${NEEDS.join(', ')})`);
    else for (const need of needs) if (!NEEDS.includes(need)) errors.push(`contracts/check-inputs.json: ${target} needs ${need}, which no setup step provides; the needs are ${NEEDS.join(', ')}`);
    const globs = declaration?.inputs;
    if (declaration?.scope === 'suite' && globs !== undefined)
      errors.push(`contracts/check-inputs.json: suite target ${target} declares inputs, which owner-check never reads`);
    if (declaration?.scope === 'owner' && (!Array.isArray(globs) || globs.length === 0) && !(Array.isArray(declaration?.lints) && declaration.lints.length > 0))
      errors.push(`contracts/check-inputs.json declares no inputs of owner target ${target}`);
    if (declaration?.scope === 'suite' && declaration?.lints !== undefined)
      errors.push(`contracts/check-inputs.json: suite target ${target} declares lints, which owner-check never reads`);
    if (declaration?.scope !== 'owner') continue;
    for (const glob of [...(Array.isArray(globs) ? globs : []), ...(Array.isArray(declaration?.lints) ? declaration.lints : [])]) {
      const pattern = globPattern(glob);
      if (!tracked.some(path => pattern.test(path))) errors.push(`contracts/check-inputs.json: ${target} input ${glob} matches no tracked file`);
    }
  }
  return errors;
}

// changedPaths는 HEAD와 다른 file과 추적하지 않는 file이다.
function changedPaths(root) {
  const run = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])])].sort();
}

// trackedPaths는 git이 추적하는 file이다.
function trackedPaths(root) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

// headManifest는 HEAD의 contracts/features.json이다. HEAD에 없으면 null이다.
function headManifest(root) {
  try { return JSON.parse(execFileSync('git', ['show', 'HEAD:contracts/features.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
}

// makeArguments는 target 하나를 실행하는 make 인자다. owner-check가 받은 서버 환경(ORM_OWNER_TEST_ENV,
// 곧 make의 TEST_ENV)과 decimal 환경(DECIMAL_ENV)을 target에도 준다: worktree는 main checkout의 서버를 쓰고,
// make 변수는 command line으로만 Makefile의 값을 바꾼다. Rust target directory는 각 checkout의 것이므로
// 넘기지 않는다(AGENTS.md).
export function makeArguments(target, env) {
  const overrides = [];
  if (env.ORM_OWNER_TEST_ENV) overrides.push(`TEST_ENV=${env.ORM_OWNER_TEST_ENV}`);
  if (env.DECIMAL_ENV) overrides.push(`DECIMAL_ENV=${env.DECIMAL_ENV}`);
  // -k: target의 독립된 부분(하위 target)은 앞 부분이 실패해도 실행한다.
  return ['--no-print-directory', '-k', ...overrides, target];
}

// make는 한 make target을 실행하고 출력 줄을 step으로 내보낸다. 기한은 target 안의 case마다 있다.
function make(root, target, { step }) {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env };
    for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
    const child = spawn('make', makeArguments(target, process.env), { cwd: root, env });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', rejectRun);
    child.on('close', code => {
      lines.flush();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`make ${target} exited with ${code}`));
    });
  });
}

// execute는 명령을 실행하고 출력 줄을 step으로 내보낸다. 기한은 명령 안의 case마다 있다.
function execute(root, args, { step }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', rejectRun);
    child.on('close', code => {
      lines.flush();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`node ${args.join(' ')} exited with ${code}`));
    });
  });
}

// usesTestEnv는 Makefile의 target 하나가 server 환경(WITH_TEST_ENV)을 읽는지다.
export function usesTestEnv(makefile, target) {
  return makeRecipes(makefile).some(unit => unit.name === `Makefile ${target}` && unit.commands.some(command => command.includes('$(WITH_TEST_ENV)')));
}

// environmentFile은 scripts/check/databases.sh가 쓴 환경 file(`export NAME='value'` 줄)의 변수다. 다른 형식의
// 줄은 오류다.
export function environmentFile(text) {
  const out = {};
  for (const line of text.split('\n').filter(line => line.trim() !== '')) {
    const match = /^export ([A-Z_][A-Z0-9_]*)='([^']*)'$/.exec(line);
    if (!match) throw new Error(`unexpected environment line: ${line}`);
    out[match[1]] = match[2];
  }
  return out;
}

// shell은 sh로 script를 실행하고 출력 줄을 step으로 내보낸다.
function shell(root, args, { step }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('sh', args, { cwd: root, env: process.env });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', rejectRun);
    child.on('close', code => {
      lines.flush();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`sh ${args.join(' ')} exited with ${code}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const args = process.argv.slice(2);
  const list = args[0] === '--list';
  const paths = list ? args.slice(1) : args;
  const changed = paths.length ? paths : changedPaths(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'contracts/features.json'), 'utf8'));
  const change = changed.includes('contracts/features.json') ? manifestChanges(headManifest(root), manifest) : undefined;
  const owners = await selectOwners(manifest, root, changed, change);
  const helpers = await selectHelpers(manifest, root, changed, change);
  const declarations = JSON.parse(await readFile(resolve(root, 'contracts/check-inputs.json'), 'utf8'));
  const declared = declarations.targets;
  const checkTargets = /^CHECK_TARGETS = (.*)$/m.exec(await readFile(resolve(root, 'Makefile'), 'utf8'))?.[1].trim().split(/\s+/) ?? [];
  const tracked = trackedPaths(root);
  const declarationErrors = [...checkInputErrors(declared, checkTargets, tracked), ...manifestInputErrors(manifest, tracked), ...pathScopeErrors(declarations.paths, tracked)];
  if (declarationErrors.length) {
    for (const error of declarationErrors) console.error(`owners: ${error}`);
    process.exit(1);
  }
  const targets = selectTargets(declared, changed);
  const commandCount = owners.reduce((sum, owner) => sum + owner.commands.length, 0);
  const partCount = owners.reduce((sum, owner) => sum + owner.parts.length, 0);
  console.log(`owners: ${changed.length} changed path(s) select ${commandCount} verification command(s) and ${partCount} coverage part(s) of ${owners.length} feature(s), ${helpers.length} helper check(s) and ${targets.length} make target(s)`);
  for (const { feature, commands, parts } of owners) {
    for (const { id, reasons } of commands) console.log(`owners: ${feature.id}/${id}: ${reasons.join(', ')}`);
    for (const { part, reasons } of parts) console.log(`owners: ${feature.id}/coverage/${part}: ${reasons.join(', ')}`);
  }
  for (const { helper, reasons } of helpers) console.log(`owners: helper ${helper.id}: ${reasons.join(', ')}`);
  for (const { target, reasons } of targets) console.log(`owners: make ${target}: ${reasons.join(', ')}`);
  // 행동 시험을 하나도 고르지 않고 scope도 선언하지 않은 path는 owner-check를 실패시킨다(untestedPaths). scope를
  // 선언한 path는 그 scope와 이유를 보인다.
  for (const path of changed.filter(path => Object.hasOwn(declarations.paths ?? {}, path)))
    console.log(`owners: ${path} is declared ${declarations.paths[path].scope}: ${declarations.paths[path].reason}`);
  if (change?.whole) console.log('owners: contracts/features.json changed outside a feature or helper entry; make check runs every feature');
  const untested = untestedPaths(changed, { owners, helpers, targets, paths: declarations.paths, exists: path => existsSync(resolve(root, path)) });
  if (untested.length) {
    for (const path of untested)
      console.error(`owners: ${path} selects no behaviour test: declare it as an input of the command that tests it (contracts/features.json, or the inputs of a make target in contracts/check-inputs.json), or declare its scope lint or suite with the reason in the paths of contracts/check-inputs.json`);
    process.exit(1);
  }
  if (!list) {
    let failed = 0;
    // 기능, helper, server 환경을 읽는 make target은 이 실행의 자기 bench database와 decimal database를
    // 쓴다(scripts/check/databases.sh, make check와 같은 것). 함께 쓰는 bench나 decimal database는 없다.
    // 만든 database는 끝에 지운다.
    const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
    const needsDatabases = owners.length > 0 || helpers.length > 0 || targets.some(({ target }) => usesTestEnv(makefile, target));
    let databases;
    if (needsDatabases) {
      const servers = process.env.ORM_OWNER_TEST_ENV;
      if (!servers) throw new Error('ORM_OWNER_TEST_ENV is unset; run make owner-check');
      const name = `orm_owner_${process.pid}_${randomBytes(4).toString('hex')}`;
      databases = { servers, name, directory: resolve(root, '.runtime/check', name) };
      const created = await runGroup('owners/databases/create', context =>
        shell(root, ['scripts/check/databases.sh', 'create', servers, databases.directory, name], context));
      if (!created) {
        failed++;
        await runGroup('owners/databases/drop', context => shell(root, ['scripts/check/databases.sh', 'drop', servers, databases.directory, name], context));
        console.log('owners: the databases of this run could not be created');
        process.exit(1);
      }
      Object.assign(process.env, environmentFile(readFileSync(resolve(databases.directory, 'env'), 'utf8')), {
        ORM_OWNER_TEST_ENV: resolve(databases.directory, 'env'),
        DECIMAL_ENV: resolve(databases.directory, 'decimal-env'),
      });
    }
    for (const { target } of targets) {
      if (!(await runGroup(`owners/make/${target}`, context => make(root, target, context)))) failed++;
    }
    // 기능 단계와 helper는 TypeScript client의 build 출력을 쓰고, 그 일부는 그 출력을 build하는 make target을 하위
    // process로 실행한다(make dbspec-ts-check 같은 검증 명령). 그래서 make target을 모두 실행한 뒤부터 이 process가
    // 끝날 때까지 그 출력의 exclusive lease를 가진다. 하위 process는 조상인 이 process의 보유 안에서
    // 같은 규칙으로 보유를 나눈다.
    if (owners.length > 0 || helpers.length > 0) {
      const { LEASE: lease, TYPESCRIPT_LEASES: leases } = process.env;
      if (!lease || !leases) throw new Error('LEASE and TYPESCRIPT_LEASES are unset; run make owner-check');
      const held = spawnSync(lease, ['hold', leases, 'exclusive', '--wait', '--pid', String(process.pid)], { stdio: 'inherit' });
      if (held.status !== 0) {
        console.log('owners: the TypeScript build output could not be held');
        process.exit(1);
      }
    }
    for (const { helper } of helpers) {
      if (!(await runGroup(`owners/helper/${helper.id}`, context => execute(root, ['scripts/features/check.mjs', '--run', '--helper', helper.id], context)))) failed++;
    }
    for (const { feature, commands, parts } of owners) {
      const steps = [];
      if (commands.length) steps.push(['verification', ['scripts/features/check.mjs', '--run', '--feature', feature.id, ...commands.flatMap(({ id }) => ['--command', id])]]);
      if (parts.length) steps.push(['coverage', ['scripts/features/coverage.mjs', '--feature', feature.id, ...parts.flatMap(({ part }) => ['--part', part])]]);
      for (const [kind, command] of steps) {
        if (!(await runGroup(`owners/${feature.id}/${kind}`, context => execute(root, command, context)))) failed++;
      }
    }
    if (databases && !(await runGroup('owners/databases/drop', context =>
      shell(root, ['scripts/check/databases.sh', 'drop', databases.servers, databases.directory, databases.name], context)))) failed++;
    if (failed) {
      console.log(`owners: ${failed} step(s) failed`);
      process.exitCode = 1;
    }
  }
}
