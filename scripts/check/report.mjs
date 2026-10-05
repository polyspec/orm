// 전체 suite 실행 하나의 보고서다(.runtime/check/<run id>/report). CI 실행 한 번이 다음 CI 실행 전에 그 실행이
// 찾은 모든 실패를 고칠 수 있을 만큼의 정보를 모아야 하므로, 실패마다 다시 실행하지 않고 진단할 수 있는 것을
// 남긴다:
//
//   environment.txt          실행의 환경: commit과 tree, OS, 도구와 server의 version, disk
//   targets/<target>.log     target의 정확한 명령, Makefile의 recipe, 입력 path, 출력 전체
//   targets/<target>/run/    실패한 target이 남긴 실행 directory(.runtime/run/<target>-<pid>)의 file
//   summary.md               target마다 상태, 시간, 첫 실패 줄. CI에서는 GITHUB_STEP_SUMMARY에도 쓴다
//
// LIMIT_BYTES보다 큰 file은 끝의 TAIL_BYTES만 남기고 그 사실을 file 첫 줄과 summary에 적는다. build
// target(`target` directory), node_modules와 database file은 옮기지 않고 manifest에 크기와 함께 적는다.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const LIMIT_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
// FAILURE_LINES는 summary와 기록이 target마다 담는 첫 실패 줄의 수다.
export const FAILURE_LINES = 20;
const SKIPPED_DIRECTORIES = new Set(['target', 'node_modules', '.git']);
const DATABASE_FILE = /\.(sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db|ibd)$/;

export const reportDirectory = (root, id) => resolve(root, '.runtime/check', id, 'report');

// failures는 target 출력 줄을 받아 실패를 모은다. case runner(tests/testcase.mjs, internal/testcase, PHP와 Rust의
// testcase)는 case마다 `RUN <case>`, `STEP <case> ...`, `PASS <case>`나 `FAIL <case> ...: <이유>`를 쓴다. 끝나지
// 않은 case(기한 초과로 멈춘 process, 죽은 process)는 RUN 뒤에 결과가 없으므로 그 case와 마지막 단계를 적는다.
export function failures() {
  const failed = [];
  const open = new Map();
  const tail = [];
  let exit = null;
  return {
    // exit는 명령이 끝난 방식이다(종료 코드나 signal). case가 실패를 보고하지 않은 실패는 출력의 끝과 이것을 적는다.
    exit(text) {
      exit = text;
    },
    line(text) {
      tail.push(text);
      if (tail.length > FAILURE_LINES) tail.shift();
      const run = /^RUN (\S+)/.exec(text);
      if (run) open.set(run[1], null);
      const step = /^STEP (\S+) /.exec(text);
      if (step && open.has(step[1])) open.set(step[1], text);
      const done = /^(PASS|FAIL|TIMEOUT) (\S+)/.exec(text);
      if (done) open.delete(done[2]);
      if (/^(FAIL|TIMEOUT)\b|^--- FAIL|^not ok\b|^panic:|^thread '.*' panicked/.test(text) && failed.length < FAILURE_LINES) failed.push(text);
    },
    // lines는 실패한 target의 첫 실패 줄이다: FAIL 줄, 끝나지 않은 case, 둘 다 없으면 출력의 마지막 줄들, 그리고
    // 명령이 끝난 방식.
    lines() {
      const pending = [...open].map(([name, last]) => `case ${name} did not finish; its last step: ${last ?? 'none (it reported no step)'}`);
      const lines = [...failed, ...pending].slice(0, FAILURE_LINES);
      return [...(lines.length ? lines : tail), ...(exit ? [exit] : [])];
    },
  };
}

function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  if (result.error) return `${program}: ${result.error.code ?? result.error.message}`;
  return `${(result.stdout || result.stderr).trim().split('\n')[0]}`;
}

// environment는 실행의 환경을 적는다. 실패한 case가 기대한 값과 다른 이유가 환경에 있을 때 다시 실행하지 않고
// 알 수 있도록 version과 disk를 남긴다.
export function writeEnvironment(root, report, extra = {}) {
  const lines = [
    `commit ${command('git', ['-C', root, 'rev-parse', 'HEAD'])}`,
    `tree ${command('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'])}`,
    `os ${command('uname', ['-a'])}`,
    `node ${process.version}`,
    `go ${command('go', ['version'])}`,
    `php ${command('php', ['--version'])}`,
    `cargo ${command('cargo', ['--version'])}`,
    `mysqld ${command('mysqld', ['--version'])}`,
    `postgres ${command('postgres', ['--version'])}`,
    `disk ${command('df', ['-h', root]).trim()}`,
    `disk available ${command('sh', ['-c', `df -k '${root}' | tail -1`])}`,
    ...Object.entries(extra).map(([key, value]) => `${key} ${value}`),
  ];
  writeFileSync(join(report, 'environment.txt'), `${lines.join('\n')}\n`);
}

// tail은 file의 마지막 TAIL_BYTES를 읽는다.
function tail(path, size) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    readSync(descriptor, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

// keepRunDirectory는 실패한 target이 남긴 실행 directory를 보고서로 옮겨 적는다. LIMIT_BYTES보다 큰 file은 끝만,
// build target, node_modules, database file과 binary file은 옮기지 않고 manifest에 이유와 크기를 적는다.
export function keepRunDirectory(source, destination) {
  const manifest = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(source, path);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) manifest.push(`${name}/ not kept: a build or dependency directory`);
        else walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const { size } = statSync(path);
      if (DATABASE_FILE.test(entry.name)) {
        manifest.push(`${name} not kept: a database file of ${size} bytes`);
        continue;
      }
      const head = Buffer.alloc(Math.min(size, 8192));
      const descriptor = openSync(path, 'r');
      readSync(descriptor, head, 0, head.length, 0);
      closeSync(descriptor);
      if (head.includes(0)) {
        manifest.push(`${name} not kept: a binary file of ${size} bytes`);
        continue;
      }
      const target = join(destination, name);
      mkdirSync(resolve(target, '..'), { recursive: true });
      if (size > LIMIT_BYTES) {
        writeFileSync(target, Buffer.concat([Buffer.from(`[the last ${TAIL_BYTES} of ${size} bytes of ${path}]\n`), tail(path, size)]));
        manifest.push(`${name} kept as its last ${TAIL_BYTES} of ${size} bytes`);
      } else {
        writeFileSync(target, readFileSync(path));
        manifest.push(`${name} kept, ${size} bytes`);
      }
    }
  };
  walk(source);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'MANIFEST.txt'), `${source}\n${manifest.join('\n')}\n`);
  return manifest.length;
}

// limitLog는 LIMIT_BYTES보다 큰 target log를 끝만 남긴 file로 바꾸고 그 사실을 돌려준다.
export function limitLog(path) {
  if (!existsSync(path)) return null;
  const { size } = statSync(path);
  if (size <= LIMIT_BYTES) return null;
  const end = tail(path, size);
  writeFileSync(path, Buffer.concat([Buffer.from(`[the last ${TAIL_BYTES} of ${size} bytes of this log]\n`), end]));
  return size;
}

const time = step => step.elapsed !== undefined ? `${(step.elapsed / 1000).toFixed(1)} s`
  : step.started && step.ended ? `${((Date.parse(step.ended) - Date.parse(step.started)) / 1000).toFixed(1)} s` : '';
const escape = text => String(text).replaceAll('|', '\\|');

// summary는 기록에서 summary.md를 만든다. run은 기록의 실행(전체 실행이면 기록 자신, 재실행이면 그 재실행)이고,
// crashed가 문자열이면 runner가 끝나지 않은 이유이며 그때 기록은 runner가 마지막으로 쓴 상태다.
export function summary(record, { run = record, report, crashed = null } = {}) {
  const steps = [...(run.setup ?? []), ...record.targets];
  const count = status => steps.filter(step => step.status === status).length;
  const lines = [
    `# make check ${run.id ?? ''}`.trim(),
    '',
    `commit \`${run.commit ?? record.commit}\`, tree \`${run.tree ?? record.tree}\`, started ${run.started ?? record.started}, ended ${run.ended ?? record.ended ?? 'never'}, result **${crashed ? 'crashed' : (run.result ?? record.result)}**`,
    '',
  ];
  if (crashed) lines.push(`**The runner did not finish: ${crashed}.** The steps below are as the runner last recorded them; a step marked running stopped with the runner.`, '');
  lines.push(`${count('passed')} passed, ${count('failed')} failed, ${count('not-run')} not run because a setup step failed, ${count('running') + count('pending')} not finished.`, '');
  if (report) lines.push(`Report: \`${report}\` (environment.txt, targets/<target>.log, targets/<target>/run/). A log or kept file larger than ${LIMIT_BYTES} bytes keeps only its last ${TAIL_BYTES} bytes, which its first line states.`, '');
  lines.push('| step | status | time | first failure lines |', '|---|---|---|---|');
  for (const step of steps) {
    const detail = step.status === 'not-run' ? step.reason : (step.failures ?? []).slice(0, 3).join(' / ');
    lines.push(`| ${escape(step.name)} | ${step.status} | ${time(step)} | ${escape(detail ?? '')} |`);
  }
  for (const step of steps.filter(step => step.status === 'failed' && step.failures?.length)) {
    lines.push('', `## ${step.name}`, '', `log: \`${step.log ?? ''}\``, '', '```', ...step.failures, '```');
  }
  return `${lines.join('\n')}\n`;
}

// publish는 summary를 보고서에 쓴다. CI의 summary 단계(scripts/check/summary.mjs)는 GITHUB_STEP_SUMMARY에도 쓴다.
export function publish(text, report, { step = false } = {}) {
  if (report) {
    mkdirSync(report, { recursive: true });
    writeFileSync(join(report, 'summary.md'), text);
  }
  if (step && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

// runName은 ORM_CHECK_RUN_ID에서 실행의 이름을 만든다. 이름은 database 이름에도 쓰므로 소문자, 숫자와 밑줄이다.
export const runName = id => `ci_${id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
