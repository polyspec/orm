// owners는 바뀐 file의 owner check를 고르고 실행한다(AGENTS.md "Owner checks").
//
//   node scripts/features/owners.mjs [--list] [<path>...]
//
// path가 없으면 HEAD에서 바뀐 file과 추적하지 않는 file이다. 기능은 contracts/features.json이
// 선언한 fixture나 test가 바뀐 path이거나, 선언한 fixture text가 바뀐 path를 적으면 고른다
// (contracts/fixtures/schema_definition.json이 렌더링하는 contracts/fixtures/audit.dbs처럼).
// 고른 기능마다 검증 명령(features/check.mjs --run --feature)과 coverage(features/coverage.mjs
// --feature)를 저마다의 기한 아래에서 차례로 실행하고 RUN, STEP, PASS, FAIL과 경과 시간을 보고한다.
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCase, stepLines } from '../../tests/testcase.mjs';

// fixture text 안의 repository path다. 확장자가 있는 상대 path만 본다.
const pathPattern = /(?:contracts|tests|schema|clients|engine)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

// namedPaths는 선언한 fixture file이 적는 repository path다. 없는 path는 버린다.
async function namedPaths(root, fixture) {
  let text;
  try { text = await readFile(resolve(root, fixture), 'utf8'); } catch { return []; }
  return [...new Set(text.match(pathPattern) ?? [])].filter(p => p !== fixture && existsSync(resolve(root, p)));
}

// selectOwners는 changed(repository 상대 path)를 입력으로 선언한 기능과 그 이유를 manifest 순서로
// 돌려준다. 이유는 선언한 path이거나 "<path> (named by <fixture>)"다.
export async function selectOwners(manifest, root, changed) {
  const out = [];
  for (const feature of manifest.features) {
    const direct = new Set([...feature.fixtures, ...feature.tests]);
    const named = new Map();
    for (const fixture of feature.fixtures) {
      for (const p of await namedPaths(root, fixture)) if (!direct.has(p) && !named.has(p)) named.set(p, fixture);
    }
    const reasons = [];
    for (const p of changed) {
      if (direct.has(p)) reasons.push(p);
      else if (named.has(p)) reasons.push(`${p} (named by ${named.get(p)})`);
    }
    if (reasons.length) out.push({ feature, reasons });
  }
  return out;
}

// changedPaths는 HEAD와 다른 file과 추적하지 않는 file이다.
function changedPaths(root) {
  const run = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])])].sort();
}

// 한 단계의 기한: 검증 명령은 test binary를 build하고 세 database에서 실행하며, coverage는 기능의
// 모든 client case를 두 번씩 실행한다. 가장 긴 schema_install coverage가 이 checkout에서 2분 안이므로
// 10분을 넘긴 단계는 멈춘 것이다.
const STEP_DEADLINE = 10 * 60_000;

// execute는 명령을 process group으로 실행하고 출력 줄을 step으로 내보낸다. 기한에 group 전체를 끝낸다.
function execute(root, args, { signal, step }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, detached: true });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already ended */ } };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', rejectRun);
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      lines.flush();
      if (signal.aborted) rejectRun(signal.reason);
      else if (code === 0) resolveRun();
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
  const owners = await selectOwners(manifest, root, changed);
  console.log(`owners: ${changed.length} changed path(s) select ${owners.length} feature(s)`);
  for (const { feature, reasons } of owners) console.log(`owners: ${feature.id}: ${reasons.join(', ')}`);
  if (!list) {
    let failed = 0;
    for (const { feature } of owners) {
      const steps = [['verification', ['scripts/features/check.mjs', '--run', '--feature', feature.id]]];
      if (feature.coverage) steps.push(['coverage', ['scripts/features/coverage.mjs', '--feature', feature.id]]);
      for (const [kind, command] of steps) {
        if (!(await runCase(`owners/${feature.id}/${kind}`, STEP_DEADLINE, context => execute(root, command, context)))) failed++;
      }
    }
    if (failed) {
      console.log(`owners: ${failed} step(s) failed`);
      process.exitCode = 1;
    }
  }
}
