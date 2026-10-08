// make check-run, make bench와 make run-databases의 runner다. 실행마다 자기 bench
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
// 실행은 database 만들기와 지우기, 각 target의 시작과 결과를 .runtime/check/<id>/record.json에
// 기록한다(scripts/check/record.mjs). 전체 suite의 guard(진행 중 항목, commit하지 않은 변경, tree마다 한 번)는
// scripts/kit의 `make check`가 이 runner 앞에서 맡는다.
//
// Usage: [ORM_CHECK_RUN_ID=<id>] node scripts/check/run.mjs [--job-summary] <servers env | -> <target>...
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { duration, runGroup } from '../../tests/testcase.mjs';
import { expandNeeds, failedCiSetup, SETUP_NEEDS } from './ci-setup.mjs';
import { startRecord } from './record.mjs';
import { runStep } from './step.mjs';
import { monitor } from './resources.mjs';
import { missingDownloads } from './downloads.mjs';

import { cappedLog, diskSnapshot, failures, keepFile, keepRunDirectory, npmErrors, NPM_LOG, publish, spaceCause, reportDirectory, reportWriter, runName, summary, writeEnvironment } from './report.mjs';

// command는 program을 단계 하나로 실행하고(runStep: 자기 임시 directory와 process group) 출력 줄을 단계로 내보낸다.
// make의 MAKEFLAGS는 넘기지 않는다: 하위 make는 이 runner가 주는 TEST_ENV와 DECIMAL_ENV만 받는다. spawned는 시작한
// process의 id를 받는다. options의 label은 실패 줄의 이름, keep은 실패한 단계의 임시 entry를 복사할 directory,
// leftovers는 단계 밖에 남은 것을 찾는 함수이고, guard: false는 setup 단계다.
export const command = root => (program, args, step, spawned = () => {}, { label, keep, leftovers, guard } = {}) => {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  return runStep(program, args, { cwd: root, env, step, label, spawned, leftovers, guard, keep: keep && (source => keepRunDirectory(source, keep)) });
};

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

// runChecks는 실행 하나를 하고 종료 상태를 돌려준다: 실패 1, 통과 0. run은
// command(root)와 같은 모양의 함수다. needs는 target마다 필요한 setup 단계('databases')이고, id는 실행의 이름이며,
// snapshot은 공간 기록(diskSnapshot과 같은 모양)이다.
export async function runChecks({ root, jobSummary = false, servers, targets: declared, run, needs = declaredNeeds(root), id = process.env.ORM_CHECK_RUN_ID, snapshot = diskSnapshot, ciSetup = process.env.ORM_CI_SETUP, downloads = missingDownloads }) {
  // 실행의 이름은 주어진 id이거나 process id와 임의의 값이다. 같은 이름의 database가 있으면 그것은 이 실행이 만든
  // 것이 아니므로 bench-db.sh가 지우지 않도록 이름이 겹치지 않아야 한다.
  const runId = id ? runName(id) : `orm_check_${process.pid}_${randomBytes(4).toString('hex')}`;
  const name = runId;
  const targets = declared;
  const { recorder, record: current } = startRecord(root, runId, targets);
  // directory는 이 실행의 database 파일(env, decimal-env, SQLite)이고 databases.sh drop이 통째로 지운다. 보고서는 그
  // 옆의 report다: drop이 보고서를 지우지 않는다.
  const directory = resolve(root, '.runtime/check', runId, 'databases');
  const report = reportDirectory(root, runId);
  // writer는 보고서의 모든 쓰기를 맡고 실패를 던지지 않고 모은다(reportWriter).
  const writer = reportWriter();
  writer.run(join(report, 'targets'), () => mkdirSync(join(report, 'targets'), { recursive: true }));
  if (current) current.report = relative(root, report);
  writer.run(join(report, 'environment.txt'), () => writeEnvironment(root, report, { 'run id': runId, servers }));
  active = { recorder, writer, report, root, current };
  // disk는 실행의 공간 기록이다(diskSnapshot): 시작할 때와 단계마다 끝난 뒤 report/disk/<n>-<단계>.txt에 쓴다. 실패한
  // 단계 뒤의 기록이 그 실패 순간의 공간이다.
  let snapshots = 0;
  const disk = label => {
    const taken = snapshot(root, resolve(root, '.runtime/check', runId));
    const file = join(report, 'disk', `${String(snapshots++).padStart(2, '0')}-${label.replaceAll('/', '-')}.txt`);
    writer.run(file, () => { mkdirSync(join(report, 'disk'), { recursive: true }); });
    writer.write(file, taken.text);
    return taken;
  };
  const started = disk('start');
  if (current) current.disk = started.places;
  const testEnv = resolve(directory, 'env');
  const decimalEnv = resolve(directory, 'decimal-env');

  const results = [];
  // record는 단계 하나를 실행한다. 출력은 target log에 쓰고 실패 줄을 모은다.
  const record = async (label, kind, body) => {
    const step = recorder.begin(label, kind);
    const started = performance.now();
    const log = join(report, 'targets', `${label.replaceAll('/', '-')}.log`);
    const found = failures();
    // npm이 적은 debug log의 경로다. 실패한 단계는 그 log를 보고서로 옮기고 그 오류 줄을 첫 실패 줄로 삼는다.
    const npmLogs = new Set();
    let pid = null;
    const keepTemporary = join(report, 'targets', label.replaceAll('/', '-'), 'tmp');
    // runDirectories는 이 단계의 make가 남긴 실행 directory(.runtime/run/<target>-<make pid>)다.
    const runDirectories = () => {
      const runs = resolve(root, '.runtime/run');
      return pid && existsSync(runs) ? readdirSync(runs).filter(entry => entry.endsWith(`-${pid}`)).map(entry => join(runs, entry)) : [];
    };
    const header = kind === 'target'
      ? [`target ${label}`, `command: make --no-print-directory -k TEST_ENV=${testEnv} DECIMAL_ENV=${decimalEnv} ${label}`, 'recipe (Makefile):', recipeText(root, label), `inputs: ${targetInputs(root, label).join(' ')}`, '']
      : [`setup step ${label}`, ''];
    const written = writer.failed.length;
    const output = cappedLog(writer, log, `${header.join('\n')}\n`);
    const passed = await runGroup(`check/${label}`, ({ step: report }) => body({
      step: text => {
        output.line(text);
        found.line(text);
        const npm = NPM_LOG.exec(text);
        if (npm) npmLogs.add(npm[1]);
        report(text);
      },
      spawned: child => { pid = child; },
      // 실패한 단계의 임시 entry는 보고서의 targets/<단계>/tmp로 복사한다. 통과한 단계가 실행 directory를 남겼으면 그
      // 단계는 실패한다.
      options: { label, keep: keepTemporary, leftovers: () => runDirectories().map(path => relative(root, path)) },
    }).catch(error => { output.line(error.message); found.exit(error.message); throw error; }));
    const elapsed = performance.now() - started;
    const truncated = output.close() || null;
    const after = disk(label);
    writer.append(log, `free space after the step (KiB): ${JSON.stringify(after.places)}\n`);
    const lines = passed ? [] : found.lines();
    // npm 오류는 보고서 밖의 debug log에 있다. 그 log를 targets/<단계>/에 옮기고 그 오류 줄을 첫 실패 줄 앞에 둔다.
    if (!passed)
      for (const path of npmLogs) {
        if (!existsSync(path)) {
          lines.unshift(`npm debug log ${path} is missing`);
          continue;
        }
        const kept = join(report, 'targets', label.replaceAll('/', '-'), basename(path));
        writer.run(kept, () => keepFile(path, kept));
        let errors = [];
        writer.run(kept, () => { errors = npmErrors(readFileSync(path, 'utf8')); });
        lines.unshift(...errors.map(error => `npm debug log ${relative(root, kept)}: ${error}`));
      }
    // 공간이 없어 실패한 단계는 그 사실과 그 순간의 공간을 첫 실패 줄로 적는다(spaceCause).
    const space = passed ? null : spaceCause(lines, after);
    if (space) lines.unshift(space);
    // 경고(`WARNING`)는 실패가 아니다. 단계의 기록과 summary에 남기고, GitHub Actions에서는 `::warning::` annotation으로도 쓴다.
    const warnings = found.warnings();
    if (process.env.GITHUB_ACTIONS === 'true') for (const warning of warnings) console.log(`::warning title=${label}::${warning}`);
    const details = { log: relative(root, log), elapsed: Math.round(elapsed), disk: after.places, ...(passed ? {} : { failures: lines }), ...(warnings.length ? { warnings } : {}), ...(truncated ? { truncated } : {}) };
    // 실패한 target이 남긴 실행 directory(.runtime/run/<target>-<make pid>)를 보고서로 복사한 뒤 지운다. 보고서가 그
    // 증거를 갖고, disk에는 남지 않는다.
    for (const path of runDirectories()) {
      if (!passed) {
        const kept = join(report, 'targets', label.replaceAll('/', '-'), 'run', basename(path));
        writer.run(kept, () => keepRunDirectory(path, kept));
      }
      rmSync(path, { recursive: true, force: true });
    }
    // 이 단계 동안 실패한 보고서 쓰기는 그 단계의 기록에 남는다.
    const reportErrors = writer.failed.slice(written);
    if (reportErrors.length) details.reportErrors = reportErrors;
    recorder.end(step, passed, details);
    results.push({ label, passed, elapsed, ...details });
    return passed;
  };
  const skip = (target, reason) => {
    recorder.notRun(target, reason);
    results.push({ label: target, passed: false, notRun: reason, elapsed: 0 });
    console.log(`NOT-RUN check/${target}: ${reason}`);
  };

  const failedSetup = {};
  // needsOf는 target이 선언한 need와 그 need의 setup 단계가 필요로 하는 need(scripts/check/ci-setup.mjs의 SETUP_NEEDS)다.
  // wanted는 이 실행의 target의 그 need다.
  const needsOf = target => expandNeeds(needs[target] ?? []);
  const wanted = new Set(targets.flatMap(needsOf));
  // CI setup step(scripts/check/ci-setup.mjs): workflow가 ORM_CI_SETUP으로 준 step 결과에서 실패한 step마다 setup 단계
  // ci/<id>를 실패로 기록하고, 그 step이 마련하는 need를 선언한 target은 not-run으로 기록한다. step의 출력은 job
  // log의 그 step에 있다. CI group의 job은 그 group의 target이 필요로 하지 않는 setup step을 건너뛴다(make
  // ci-group-needs): 건너뛴 step은 그 need를 선언한 target이 이 실행에 있을 때만 실패다.
  for (const { id: step, need, outcome } of failedCiSetup(ciSetup)) {
    if (outcome === 'skipped' && !wanted.has(need)) {
      console.log(`check: the CI setup step ${step} was skipped; no target of this run needs ${need}`);
      continue;
    }
    const reason = outcome === 'skipped'
      ? `the CI setup step ${step} was skipped, and a target of this run needs ${need}; make ci-group-needs runs the setup steps of the needs that contracts/check-inputs.json declares for the targets of the group`
      : `the CI setup step ${step} failed; its output is in the job log of that step`;
    if (!results.some(result => result.label === `ci/${step}`))
      await record(`ci/${step}`, 'setup', async ({ step: line }) => {
        line(reason);
        throw new Error(reason);
      });
    failedSetup[need] ??= reason;
  }
  // downloads: check가 읽는 download가 있는지 network 없이 확인한다(scripts/check/downloads.mjs). 빠진 download의 need를
  // 선언한 target은 그 이유(`run make install`)와 함께 not-run으로 기록하고, 나머지 target은 실행한다.
  // 확인하는 것은 실행하는 target이 선언한 need의 download뿐이다: 문서만 build하는 실행은 Rust crate가 필요 없다.
  let missing = [];
  await record('downloads', 'setup', async ({ step }) => {
    missing = downloads(root).filter(({ need }) => wanted.has(need));
    for (const { message } of missing) step(`downloads: ${message}`);
    if (missing.length) throw new Error(`${missing.length} download(s) of the checks are missing; run make install, which downloads them`);
    step('downloads: every download of the checks is present');
  });
  for (const { need, message } of missing) failedSetup[need] ??= message;
  // servers: test server 환경을 읽어 하위 make에 주고, server의 shared lease를 이 process가 끝날 때까지 잡는다. servers가
  // 없는 실행(ci.yml의 job docs, `-`)은 server와 database 단계를 두지 않고, database가 필요한 target을 not-run으로 기록한다.
  // 어느 target도 database가 필요하지 않은 실행(database 없는 CI group)은 server를 읽지 않고 database를 만들지 않는다.
  if (servers && !wanted.has('databases')) {
    console.log(`check: no target of this run needs databases; the run reads no servers and creates no databases`);
    servers = null;
  }
  if (!servers) failedSetup.databases = 'this run has no database servers';
  // databases의 setup 단계가 필요로 하는 need(SETUP_NEEDS)가 마련되지 않았으면 server를 읽거나 database를 만들지 않고, 그 이유로
  // databases를 실패로 기록한다.
  const unmet = servers && SETUP_NEEDS.databases.find(need => failedSetup[need]);
  if (unmet) {
    failedSetup.databases = `the setup steps servers and databases/create need ${unmet}: ${failedSetup[unmet]}`;
    servers = null;
  }
  const serversReady = servers && await record('servers', 'setup', async ({ step }) => {
    const env = serverEnvironment(servers);
    Object.assign(process.env, env);
    step(`read ${Object.keys(env).length} variables from ${servers}`);
    if (process.env.LEASE && env.ORM_TEST_SERVERS_LEASES) {
      const held = spawnSync(process.env.LEASE, ['hold', env.ORM_TEST_SERVERS_LEASES, 'shared', '--pid', String(process.pid)], { encoding: 'utf8' });
      if (held.status !== 0) throw new Error(`${process.env.LEASE} hold ${env.ORM_TEST_SERVERS_LEASES} shared exited with ${held.status}: ${(held.stderr || held.stdout).trim()}`);
      step(`holding the shared lease of ${env.ORM_TEST_SERVERS_LEASES}`);
    }
  });
  if (servers && !serversReady) failedSetup.databases = `the setup step servers failed: ${results.at(-1).failures.join(' / ')}`;
  let created = false;
  if (serversReady) {
    created = await record('databases/create', 'setup', ({ step, spawned }) =>
      run('sh', ['scripts/check/databases.sh', 'create', servers, directory, name], step, spawned, { guard: false }));
    if (!created) failedSetup.databases = `the setup step databases/create failed: ${results.at(-1).failures.join(' / ')}`;
  }
  for (const target of targets) {
    const blocked = needsOf(target).find(need => failedSetup[need]);
    if (blocked) {
      skip(target, failedSetup[blocked]);
      continue;
    }
    await record(target, 'target', async ({ step, spawned, options }) => {
      // 하위 make는 Makefile이 정하는 이 checkout의 Rust target directory를 쓴다(AGENTS.md).
      // -k는 recipe의 하위 target 하나가 실패해도 그와 무관한 하위 target을 실행한다.
      await run('make', ['--no-print-directory', '-k', `TEST_ENV=${created ? testEnv : servers ?? ''}`, `DECIMAL_ENV=${decimalEnv}`, target], step, spawned, options);
    });
  }
  // database는 만들기가 중간에 실패해도 만든 만큼 지운다.
  if (serversReady)
    await record('databases/drop', 'setup', ({ step, spawned }) =>
      run('sh', ['scripts/check/databases.sh', 'drop', servers, directory, name], step, spawned, { guard: false }));

  for (const { label, passed, notRun, elapsed } of results)
    console.log(`check: ${notRun ? 'NOT-RUN' : passed ? 'PASS' : 'FAIL'} ${label} elapsed=${duration(elapsed)}${notRun ? `: ${notRun}` : ''}`);
  // 단계 밖에서 실패한 보고서 쓰기와 기록 쓰기도 실행의 기록과 summary에 남는다.
  const stepErrors = new Set(results.flatMap(result => result.reportErrors ?? []));
  const runErrors = [...writer.failed.filter(error => !stepErrors.has(error)), ...recorder.writeErrors];
  if (current && runErrors.length) current.reportErrors = runErrors;
  const finished = recorder.finish();
  const failed = results.filter(result => !result.passed);
  const writeFailures = writer.failed.length + recorder.writeErrors.length;
  if (writeFailures) console.log(`check: ${writeFailures} report or record write(s) failed:\n${[...writer.failed, ...recorder.writeErrors].join('\n')}`);
  if (failed.length) console.log(`check: ${failed.length} of ${results.length} step(s) failed or did not run; report ${relative(root, report)}`);
  // summary는 기록에서 만든다. jobSummary인 실행(make run-databases, make bench, ci.yml의 job docs가 실행하는 make docs-ci)은
  // 그 summary를 GITHUB_STEP_SUMMARY에도 쓴다: 그 실행 뒤에는 summary 단계(scripts/check/summary.mjs)가 없다.
  writer.run(join(report, 'summary.md'), () => publish(summary(finished, { run: current, report: relative(root, report) }), report, { step: jobSummary }));
  active = null;
  return failed.length || writeFailures ? 1 : 0;
}

// active는 진행 중인 실행이다. runner가 처리하지 못한 오류(uncaughtException, unhandledRejection)는 crash가 기록한다.
let active = null;

// handleCrashes는 처리하지 못한 오류(uncaughtException, unhandledRejection)를 crash로 기록하고 1로 끝내게 한다.
export function handleCrashes() {
  for (const event of ['uncaughtException', 'unhandledRejection'])
    process.on(event, error => { crash(error); process.exit(1); });
}

// crash는 처리하지 못한 오류를 `runner error: <stack>`으로 실행 기록에 남기고 실행을 crashed로 적은 뒤 summary를 쓴다.
// 그 쓰기도 던지지 않는다. 호출한 쪽이 0이 아닌 상태로 끝낸다.
export function crash(error) {
  const reason = `runner error: ${error?.stack ?? String(error)}`;
  console.error(`check: ${reason}`);
  if (!active) return;
  const { recorder, writer, report, root, current } = active;
  active = null;
  const record = recorder.crash(reason);
  if (record) writer.run(join(report, 'summary.md'), () => publish(summary(record, { run: current, report: relative(root, report), crashed: reason }), report));
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jobSummary = args[0] === '--job-summary';
  if (jobSummary) args.shift();
  const [serversArgument, ...targets] = args;
  const valid = serversArgument && targets.length > 0 && targets.every(target => /^[a-z0-9-]+$/.test(target));
  if (!valid) {
    console.error('usage: node scripts/check/run.mjs [--job-summary] <servers env | -> <target>...');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  handleCrashes();
  // 30초마다 memory, disk, RSS가 큰 process, 보낸 group signal을 stdout에 쓴다(scripts/check/resources.mjs).
  const stopMonitor = monitor();
  // servers `-`는 server 없는 실행이다.
  process.exitCode = await runChecks({ root, jobSummary, servers: serversArgument === '-' ? null : resolve(serversArgument), targets, run: command(root) });
  stopMonitor();
}
