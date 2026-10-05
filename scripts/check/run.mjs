// make check, make rerun-failed, make bench와 make run-databases의 runner다. 실행마다 자기 bench
// database와 decimal database를 만들어(scripts/check/databases.sh) 모든 target이 그것을 쓰게 하고,
// target을 하나씩 `make <target>`으로 실행한 뒤 database를 지운다. 공유 database에 다른 실행이나
// session이 남긴 상태에 기대지 않기 위해서다.
//
// target 하나는 저마다 기한을 가진 case의 묶음이므로 runGroup으로 "RUN check/<target> group",
// 그 target의 출력 줄(STEP), PASS나 FAIL과 경과 시간을 보고한다. 각 target 앞에는 disk의 남은
// 공간을 단계로 출력한다. 실행은 실패에서 멈추지 않는다: 실패한 target이 있어도 나머지 target을 실행하고,
// target은 `make -k`로 실행해 recipe의 독립된 하위 target도 앞의 실패 뒤에 실행한다. setup 단계는 servers(test
// server 환경 file을 읽고 그 server의 shared lease를 잡는다)와 databases/create다. 실패한 setup 단계가 필요한
// target(contracts/check-inputs.json의 `needs`)은 실행하지 않고 `not-run`으로, 실패한 단계와 그 첫 실패 줄을
// 이유로 기록하며, 필요 없는 target은 실행한다. 실행마다 보고서(scripts/check/report.mjs)를 쓴다: target마다
// 정확한 명령, recipe, 입력과 출력, 실패한 target의 실행 directory, 환경, 그리고 끝에 summary다. 실패하거나
// 실행하지 않은 target이 있으면 1로 끝난다. 실행의 id는 ORM_CHECK_RUN_ID(CI는 run id와 attempt를 준다)이거나
// 실행마다 새로 만든 이름이며, 보고서는 .runtime/check/<id>/report에 있다.
//
// `--full-run`(make check)과 `--rerun-failed`(make rerun-failed)는 전체 suite의 guard
// (scripts/check/full-run.mjs)가 어떤 단계보다 먼저 실행을 허용해야 시작하고, 거부되면 2로 끝난다.
// 허용된 실행은 database 만들기와 지우기, 각 target의 시작과 결과를 .runtime/full-run.json에
// 기록한다. `--rerun-failed`는 target을 인자로 받지 않고 그 기록에서 통과하지 못한 target을 실행한다.
//
// Usage: [ORM_CHECK_RUN_ID=<id>] node scripts/check/run.mjs [--full-run] <servers env> <target>...
//        node scripts/check/run.mjs --rerun-failed <servers env>
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { duration, runGroup, stepLines } from '../../tests/testcase.mjs';
import { claim, ENTRIES, printRefusal } from './full-run.mjs';
import { failures, keepRunDirectory, limitLog, publish, reportDirectory, runName, summary, writeEnvironment } from './report.mjs';

// command는 program을 실행하고 출력 줄을 단계로 내보낸다. make의 MAKEFLAGS는 넘기지 않는다:
// 하위 make는 이 runner가 주는 TEST_ENV와 DECIMAL_ENV만 받는다. spawned는 시작한 process의 id를 받는다.
export const command = root => (program, args, step, spawned = () => {}) => new Promise((finish, fail) => {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned(child.pid);
  const lines = stepLines(step);
  child.stdout.on('data', chunk => lines.write(String(chunk)));
  child.stderr.on('data', chunk => lines.write(String(chunk)));
  child.on('error', fail);
  child.on('close', (code, signal) => {
    lines.flush();
    if (code === 0) finish();
    else fail(new Error(`${program} ${args.join(' ')} exited with ${code ?? `signal ${signal}`}`));
  });
});

// serverEnvironment는 make test-servers가 쓴 환경 file(`export NAME='value'` 줄)을 읽는다. file이 없으면 server가
// 시작하지 않은 것이므로 그 path와 함께 던진다.
export function serverEnvironment(path) {
  if (!existsSync(path)) throw new Error(`${path} is missing: make test-servers did not write the server environment`);
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^export ([A-Z0-9_]+)='([^']*)'$/.exec(line);
    if (match) env[match[1]] = match[2];
    else if (line.trim() && !line.startsWith('#')) throw new Error(`${path}: an unreadable line: ${line}`);
  }
  return env;
}

// declaredNeeds는 contracts/check-inputs.json에서 target마다 필요한 setup 단계를 읽는다.
export function declaredNeeds(root) {
  const targets = JSON.parse(readFileSync(resolve(root, 'contracts/check-inputs.json'), 'utf8')).targets;
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.needs ?? []]));
}

// recipeText는 Makefile에서 target의 정의 줄과 명령 줄이다. 보고서의 target log가 정확한 명령과 함께 적는다.
function recipeText(root, target) {
  const path = resolve(root, 'Makefile');
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex(line => line.startsWith(`${target}:`) && !line.startsWith(`${target}:=`));
  if (at < 0) return '';
  const body = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line);
  }
  return body.join('\n');
}

function targetInputs(root, target) {
  const path = resolve(root, 'contracts/check-inputs.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).targets[target]?.inputs ?? [];
}

// runChecks는 실행 하나를 하고 종료 상태를 돌려준다: 거부 2, 실패 1, 통과 0. mode는 'check'(전체 suite),
// 'rerun-failed'나 undefined(make bench, make run-databases: guard와 기록이 없다)다. run은
// command(root)와 같은 모양의 함수다. needs는 target마다 필요한 setup 단계('databases')이고, id는 실행의 이름이다.
export async function runChecks({ root, mode, servers, targets: declared, run, needs = declaredNeeds(root), id = process.env.ORM_CHECK_RUN_ID }) {
  // 실행의 이름은 주어진 id이거나 process id와 임의의 값이다. 같은 이름의 database가 있으면 그것은 이 실행이 만든
  // 것이 아니므로 bench-db.sh가 지우지 않도록 이름이 겹치지 않아야 한다.
  const runId = id ? runName(id) : `orm_check_${process.pid}_${randomBytes(4).toString('hex')}`;
  const name = runId;
  let targets = declared;
  let recorder;
  let recorded;
  let current;
  if (mode) {
    const claimed = claim(root, mode, declared, runId);
    if (claimed.refused) {
      printRefusal(ENTRIES[mode], claimed.refused);
      return 2;
    }
    ({ targets, recorder, record: recorded, run: current } = claimed);
  }
  const directory = resolve(root, '.runtime/check', runId);
  const report = reportDirectory(root, runId);
  mkdirSync(join(report, 'targets'), { recursive: true });
  if (current) current.report = relative(root, report);
  writeEnvironment(root, report, { 'run id': runId, servers });
  const testEnv = resolve(directory, 'env');
  const decimalEnv = resolve(directory, 'decimal-env');

  const results = [];
  // record는 단계 하나를 실행한다. 출력은 target log에 쓰고 실패 줄을 모은다.
  const record = async (label, kind, body) => {
    const step = recorder?.begin(label, kind);
    const started = performance.now();
    const log = join(report, 'targets', `${label.replaceAll('/', '-')}.log`);
    const found = failures();
    let pid = null;
    const header = kind === 'target'
      ? [`target ${label}`, `command: make --no-print-directory -k TEST_ENV=${testEnv} DECIMAL_ENV=${decimalEnv} ${label}`, 'recipe (Makefile):', recipeText(root, label), `inputs: ${targetInputs(root, label).join(' ')}`, '']
      : [`setup step ${label}`, ''];
    writeFileSync(log, `${header.join('\n')}\n`);
    const passed = await runGroup(`check/${label}`, ({ step: report }) => body({
      step: text => { appendFileSync(log, `${text}\n`); found.line(text); report(text); },
      spawned: child => { pid = child; },
    }).catch(error => { appendFileSync(log, `${error.message}\n`); found.exit(error.message); throw error; }));
    const elapsed = performance.now() - started;
    const truncated = limitLog(log);
    const details = { log: relative(root, log), elapsed: Math.round(elapsed), ...(passed ? {} : { failures: found.lines() }), ...(truncated ? { truncated } : {}) };
    // 실패한 target이 남긴 실행 directory(.runtime/run/<target>-<make pid>)를 보고서로 옮긴다.
    if (!passed && pid) {
      const runs = resolve(root, '.runtime/run');
      for (const entry of existsSync(runs) ? readdirSync(runs) : [])
        if (entry.endsWith(`-${pid}`)) keepRunDirectory(join(runs, entry), join(report, 'targets', label.replaceAll('/', '-'), 'run', entry));
    }
    if (step) recorder.end(step, passed, details);
    results.push({ label, passed, elapsed, ...details });
    return passed;
  };
  const skip = (target, reason) => {
    recorder?.notRun(target, reason);
    results.push({ label: target, passed: false, notRun: reason, elapsed: 0 });
    console.log(`NOT-RUN check/${target}: ${reason}`);
  };

  const failedSetup = {};
  // servers: test server 환경을 읽어 하위 make에 주고, server의 shared lease를 이 process가 끝날 때까지 잡는다.
  const serversReady = await record('servers', 'setup', async ({ step }) => {
    const env = serverEnvironment(servers);
    Object.assign(process.env, env);
    step(`read ${Object.keys(env).length} variables from ${servers}`);
    if (process.env.LEASE && env.ORM_TEST_SERVERS_LEASES) {
      const held = spawnSync(process.env.LEASE, ['hold', env.ORM_TEST_SERVERS_LEASES, 'shared', '--pid', String(process.pid)], { encoding: 'utf8' });
      if (held.status !== 0) throw new Error(`${process.env.LEASE} hold ${env.ORM_TEST_SERVERS_LEASES} shared exited with ${held.status}: ${(held.stderr || held.stdout).trim()}`);
      step(`holding the shared lease of ${env.ORM_TEST_SERVERS_LEASES}`);
    }
  });
  if (!serversReady) failedSetup.databases = `the setup step servers failed: ${results.at(-1).failures.join(' / ')}`;
  let created = false;
  if (serversReady) {
    created = await record('databases/create', 'setup', ({ step, spawned }) =>
      run('sh', ['scripts/check/databases.sh', 'create', servers, directory, name], step, spawned));
    if (!created) failedSetup.databases = `the setup step databases/create failed: ${results.at(-1).failures.join(' / ')}`;
  }
  for (const target of targets) {
    const blocked = (needs[target] ?? []).find(need => failedSetup[need]);
    if (blocked) {
      skip(target, failedSetup[blocked]);
      continue;
    }
    await record(target, 'target', async ({ step, spawned }) => {
      const disk = await statfs(root);
      step(`free disk ${(disk.bavail * disk.bsize / 2 ** 30).toFixed(1)} GiB`);
      // 하위 make는 MAKEFLAGS를 받지 않으므로, 이 runner를 실행한 make의 CARGO_TARGET_DIR(worktree가 main checkout의
      // target directory를 쓸 때 그 값)도 command line으로 넘긴다. 그렇지 않으면 Makefile이 자기 checkout의
      // target directory를 정한다. -k는 recipe의 하위 target 하나가 실패해도 그와 무관한 하위 target을 실행한다.
      const targetDir = process.env.CARGO_TARGET_DIR ? [`CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR}`] : [];
      await run('make', ['--no-print-directory', '-k', `TEST_ENV=${created ? testEnv : servers}`, `DECIMAL_ENV=${decimalEnv}`, ...targetDir, target], step, spawned);
    });
  }
  // database는 만들기가 중간에 실패해도 만든 만큼 지운다.
  if (serversReady)
    await record('databases/drop', 'setup', ({ step, spawned }) =>
      run('sh', ['scripts/check/databases.sh', 'drop', servers, directory, name], step, spawned));

  for (const { label, passed, notRun, elapsed } of results)
    console.log(`check: ${notRun ? 'NOT-RUN' : passed ? 'PASS' : 'FAIL'} ${label} elapsed=${duration(elapsed)}${notRun ? `: ${notRun}` : ''}`);
  const finished = recorder?.finish();
  const failed = results.filter(result => !result.passed);
  if (failed.length) console.log(`check: ${failed.length} of ${results.length} step(s) failed or did not run; report ${relative(root, report)}`);
  // summary는 기록에서 만든다. 기록이 없는 실행(make bench, make run-databases)은 이 실행의 결과로 만든다.
  publish(summary(finished ?? {
    commit: '', tree: '', started: '', ended: new Date().toISOString(), result: failed.length ? 'failed' : 'passed',
    setup: results.filter(result => ['servers', 'databases/create', 'databases/drop'].includes(result.label)).map(toStep),
    targets: results.filter(result => !['servers', 'databases/create', 'databases/drop'].includes(result.label)).map(toStep),
  }, { run: current, report: relative(root, report) }), report);
  return failed.length ? 1 : 0;
}

const toStep = result => ({ name: result.label, status: result.notRun ? 'not-run' : result.passed ? 'passed' : 'failed', elapsed: result.elapsed, reason: result.notRun, failures: result.failures, log: result.log });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = { '--full-run': 'check', '--rerun-failed': 'rerun-failed' }[args[0]];
  if (mode) args.shift();
  const [serversArgument, ...targets] = args;
  const valid = serversArgument && targets.every(target => /^[a-z0-9-]+$/.test(target))
    && (mode === 'rerun-failed' ? targets.length === 0 : targets.length > 0);
  if (!valid) {
    console.error('usage: node scripts/check/run.mjs [--full-run] <servers env> <target>...\n       node scripts/check/run.mjs --rerun-failed <servers env>');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  process.exitCode = await runChecks({ root, mode, servers: resolve(serversArgument), targets, run: command(root) });
}
