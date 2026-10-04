// owners는 바뀐 file의 owner check를 고르고 실행한다(AGENTS.md "Owner checks").
//
//   node scripts/features/owners.mjs [--list] [<path>...]
//
// path가 없으면 HEAD에서 바뀐 file과 추적하지 않는 file이다. 기능은 contracts/features.json이
// 선언한 fixture나 test가 바뀐 path이거나, 선언한 fixture text가 바뀐 path를 적으면 고른다
// (contracts/fixtures/schema_definition.json이 렌더링하는 contracts/fixtures/audit.dbs처럼). 그렇게 적힌
// JSON file이 적는 file도 같다(contracts/symbols/rust.json이 적는 Rust source).
// contracts/features.json이 바뀌면 HEAD의 manifest와 달라진 기능 항목의 기능을 고른다.
// 고른 기능마다 검증 명령(features/check.mjs --run --feature)과 coverage(features/coverage.mjs
// --feature)만 차례로 실행하고 RUN, STEP, PASS, FAIL과 경과 시간을 보고한다. 기한은 그 안의 case마다
// 있고, 단계 전체에 거는 기한은 없다.
// 또 contracts/check-inputs.json이 scope owner로 선언한 make target 중 입력이 바뀐 path를 맞추는
// target(예: docs/*.md에 docs-check와 docs-verify-idempotent)을 먼저 실행한다. scope suite인 target은
// 전체 suite(make check)에서만 실행하고 여기서는 고르지 않는다. scope를 선언하지 않은 target이 있으면
// 아무것도 실행하지 않고 실패한다.
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runGroup, stepLines } from '../../tests/testcase.mjs';

// fixture text 안의 repository path다. 확장자가 있는 상대 path만 본다.
const pathPattern = /(?:contracts|tests|schema|clients|engine)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

// namedPaths는 선언한 fixture file이 적는 repository path다. 없는 path는 버린다.
async function namedPaths(root, fixture) {
  let text;
  try { text = await readFile(resolve(root, fixture), 'utf8'); } catch { return []; }
  return [...new Set(text.match(pathPattern) ?? [])].filter(p => p !== fixture && existsSync(resolve(root, p)));
}

// manifestChanges는 previous(HEAD의 contracts/features.json)와 current 사이에서 항목이 달라졌거나 새로
// 생긴 기능의 id를 current 순서로 돌려준다. whole은 기능 항목 밖의 field가 달라졌거나 기능이 사라졌거나
// previous가 없다는 뜻이다. 그런 변경은 한 기능의 것이 아니므로 전체 suite가 검사한다.
export function manifestChanges(previous, current) {
  const before = new Map((previous?.features ?? []).map(feature => [feature.id, feature]));
  const features = (current.features ?? []).filter(feature => !isDeepStrictEqual(before.get(feature.id), feature)).map(feature => feature.id);
  const outside = manifest => Object.fromEntries(Object.entries(manifest ?? {}).filter(([key]) => key !== 'features'));
  const ids = new Set((current.features ?? []).map(feature => feature.id));
  const whole = !previous || !isDeepStrictEqual(outside(previous), outside(current)) || [...before.keys()].some(id => !ids.has(id));
  return { features, whole };
}

// selectOwners는 changed(repository 상대 path)를 입력으로 선언한 기능과 그 이유를 manifest 순서로
// 돌려준다. 이유는 선언한 path이거나 "<path> (named by <fixture>)"다. changed에 contracts/features.json이
// 있으면 change(manifestChanges의 결과)가 적는 기능도 "contracts/features.json (entry of <id>)"로 고른다.
export async function selectOwners(manifest, root, changed, change) {
  const out = [];
  for (const feature of manifest.features) {
    const direct = new Set([...feature.fixtures, ...feature.tests]);
    // 선언한 fixture가 적는 file, 그리고 그렇게 적힌 JSON file이 다시 적는 file이다
    // (contracts/interfaces.json → contracts/symbols/rust.json → Rust source).
    const named = new Map();
    const pending = [...feature.fixtures];
    const read = new Set(pending);
    while (pending.length) {
      const fixture = pending.shift();
      for (const p of await namedPaths(root, fixture)) {
        if (direct.has(p) || named.has(p)) continue;
        named.set(p, fixture);
        if (p.endsWith('.json') && !read.has(p)) {
          read.add(p);
          pending.push(p);
        }
      }
    }
    const reasons = [];
    for (const p of changed) {
      if (direct.has(p)) reasons.push(p);
      else if (named.has(p)) reasons.push(`${p} (named by ${named.get(p)})`);
      else if (p === 'contracts/features.json' && change?.features.includes(feature.id)) reasons.push(`${p} (entry of ${feature.id})`);
    }
    if (reasons.length) out.push({ feature, reasons });
  }
  return out;
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

// selectTargets는 declared(contracts/check-inputs.json의 targets)에서 scope owner이고 입력 pattern이
// changed path를 맞추는 make target과 그 path를 선언 순서로 돌려준다. scope를 선언하지 않은 target이
// 있으면 던진다.
export function selectTargets(declared, changed) {
  const out = [];
  for (const [target, declaration] of Object.entries(declared))
    if (!scopes.includes(declaration?.scope)) throw new Error(scopeError(target));
  for (const [target, { scope, inputs }] of Object.entries(declared)) {
    if (scope !== 'owner') continue;
    const patterns = (inputs ?? []).map(globPattern);
    const reasons = changed.filter(path => patterns.some(pattern => pattern.test(path)));
    if (reasons.length) out.push({ target, reasons });
  }
  return out;
}

// checkInputErrors는 declared가 CHECK_TARGETS의 target에 scope(owner나 suite)를 선언하지 않거나,
// CHECK_TARGETS에 없는 target을 선언하거나, owner target에 입력이 없거나, suite target에 쓰이지 않을
// 입력이 있거나, pattern이 추적되는 file을 하나도 맞추지 않는 곳마다 오류 하나를 돌려준다.
export function checkInputErrors(declared, targets, tracked) {
  const errors = [];
  for (const target of targets)
    if (!scopes.includes(declared[target]?.scope))
      errors.push(`contracts/check-inputs.json declares no scope of ${target} of CHECK_TARGETS`);
  for (const [target, declaration] of Object.entries(declared)) {
    if (!targets.includes(target)) errors.push(`contracts/check-inputs.json declares ${target}, which is not in CHECK_TARGETS`);
    const globs = declaration?.inputs;
    if (declaration?.scope === 'suite' && globs !== undefined)
      errors.push(`contracts/check-inputs.json: suite target ${target} declares inputs, which owner-check never reads`);
    if (declaration?.scope === 'owner' && (!Array.isArray(globs) || globs.length === 0))
      errors.push(`contracts/check-inputs.json declares no inputs of owner target ${target}`);
    if (declaration?.scope !== 'owner') continue;
    for (const glob of Array.isArray(globs) ? globs : []) {
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
// 곧 make의 TEST_ENV), decimal 환경(DECIMAL_ENV), Rust target directory(ORM_OWNER_CARGO_TARGET_DIR, 곧
// CARGO_TARGET_DIR)를 target에도 준다: worktree는 main checkout의 서버와 target directory를 쓰고, make
// 변수는 command line으로만 Makefile의 값을 바꾼다.
export function makeArguments(target, env) {
  const overrides = [];
  if (env.ORM_OWNER_TEST_ENV) overrides.push(`TEST_ENV=${env.ORM_OWNER_TEST_ENV}`);
  if (env.DECIMAL_ENV) overrides.push(`DECIMAL_ENV=${env.DECIMAL_ENV}`);
  if (env.ORM_OWNER_CARGO_TARGET_DIR) overrides.push(`CARGO_TARGET_DIR=${env.ORM_OWNER_CARGO_TARGET_DIR}`);
  return ['--no-print-directory', ...overrides, target];
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const args = process.argv.slice(2);
  const list = args[0] === '--list';
  const paths = list ? args.slice(1) : args;
  const changed = paths.length ? paths : changedPaths(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'contracts/features.json'), 'utf8'));
  const change = changed.includes('contracts/features.json') ? manifestChanges(headManifest(root), manifest) : undefined;
  const owners = await selectOwners(manifest, root, changed, change);
  const declared = JSON.parse(await readFile(resolve(root, 'contracts/check-inputs.json'), 'utf8')).targets;
  const checkTargets = /^CHECK_TARGETS = (.*)$/m.exec(await readFile(resolve(root, 'Makefile'), 'utf8'))?.[1].trim().split(/\s+/) ?? [];
  const declarationErrors = checkInputErrors(declared, checkTargets, trackedPaths(root));
  if (declarationErrors.length) {
    for (const error of declarationErrors) console.error(`owners: ${error}`);
    process.exit(1);
  }
  const targets = selectTargets(declared, changed);
  console.log(`owners: ${changed.length} changed path(s) select ${owners.length} feature(s) and ${targets.length} make target(s)`);
  for (const { feature, reasons } of owners) console.log(`owners: ${feature.id}: ${reasons.join(', ')}`);
  for (const { target, reasons } of targets) console.log(`owners: make ${target}: ${reasons.join(', ')}`);
  if (change?.whole) console.log('owners: contracts/features.json changed outside a feature entry; make check runs every feature');
  if (!list) {
    let failed = 0;
    for (const { target } of targets) {
      if (!(await runGroup(`owners/make/${target}`, context => make(root, target, context)))) failed++;
    }
    for (const { feature } of owners) {
      const steps = [['verification', ['scripts/features/check.mjs', '--run', '--feature', feature.id]]];
      if (feature.coverage) steps.push(['coverage', ['scripts/features/coverage.mjs', '--feature', feature.id]]);
      for (const [kind, command] of steps) {
        if (!(await runGroup(`owners/${feature.id}/${kind}`, context => execute(root, command, context)))) failed++;
      }
    }
    if (failed) {
      console.log(`owners: ${failed} step(s) failed`);
      process.exitCode = 1;
    }
  }
}
