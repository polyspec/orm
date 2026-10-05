// 전체 suite 실행 하나의 보고서다(.runtime/check/<run id>/report). CI 실행 한 번이 다음 CI 실행 전에 그 실행이
// 찾은 모든 실패를 고칠 수 있을 만큼의 정보를 모아야 하므로, 실패마다 다시 실행하지 않고 진단할 수 있는 것을
// 남긴다:
//
//   environment.txt          실행의 환경: commit과 tree, OS, 도구와 server의 version, disk
//   targets/<target>.log     target의 정확한 명령, Makefile의 recipe, 입력 path, 출력 전체
//   targets/<target>/run/    실패한 target이 남긴 실행 directory(.runtime/run/<target>-<pid>)의 file
//   summary.md               target마다 상태, 시간, 첫 실패 줄. CI에서는 GITHUB_STEP_SUMMARY에도 쓴다
//   record.json              .runtime/full-run.json의 그 실행 기록(CI의 summary 단계가 쓴다)
//   servers/*.log            test server의 log(CI의 summary 단계가 쓴다)
//
// target log는 처음 LIMIT_BYTES와 마지막 TAIL_BYTES를 남기고(cappedLog), 옮기는 file 가운데 LIMIT_BYTES보다 큰
// file은 끝의 TAIL_BYTES만 남기며 그 사실을 file 첫 줄과 summary에 적는다. build
// target(`target` directory), node_modules와 database file은 옮기지 않고 manifest에 크기와 함께 적는다.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

export const LIMIT_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
// FAILURE_LINES는 summary와 기록이 target마다 담는 첫 실패 줄의 수다.
export const FAILURE_LINES = 20;
const SKIPPED_DIRECTORIES = new Set(['target', 'node_modules', '.git']);
const DATABASE_FILE = /\.(sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db|ibd)$/;

export const reportDirectory = (root, id) => resolve(root, '.runtime/check', id, 'report');

// reportWriter는 보고서의 모든 쓰기를 맡는다. 쓰기는 던지지 않는다: 실패하면 `report write failed: <path>: <code>
// <message>`를 failed에 모으고 false를 돌려준다. runner는 그것을 단계 기록과 summary에 싣고 1로 끝난다. 없는
// directory는 다시 만들지 않는다: 보고서 directory가 실행 도중 사라졌다면 그 사실이 실패로 남아야 한다.
export function reportWriter() {
  const failed = [];
  const attempt = (path, action) => {
    try {
      action();
      return true;
    } catch (error) {
      failed.push(`report write failed: ${path}: ${error.code ?? error.name}: ${error.message}`);
      return false;
    }
  };
  return {
    failed,
    write: (path, text) => attempt(path, () => writeFileSync(path, text)),
    append: (path, text) => attempt(path, () => appendFileSync(path, text)),
    // run은 보고서에 쓰는 다른 작업(환경, 실행 directory 보관, log 줄이기)을 같은 규칙으로 실행한다.
    run: (path, action) => attempt(path, action),
  };
}

// failureLine은 줄이 실패나 오류 수준의 출력인지다. 줄 앞의 lane 접두사(`[rust] `, client-db-test의 병렬 lane)와 GitHub의
// annotation(`##[error]`)은 떼고 본다. 통과나 시작을 알리는 줄(PASS, RUN)은 오류 낱말을 담아도 실패가 아니다. 단계
// 줄(`STEP <case> elapsed=...: <message>`)은 case 이름이 아니라 그 message로 판단하고, 오류 낱말은 `driver-error/...`
// 같은 이름의 일부(앞에 `-`, `/`, `.`이나 글자가 붙은 것)가 아닐 때만 센다.
const LANE = /^(?:##\[\w+\])?(?:\[[\w-]+\] )?/;
const FAILURE = [
  /^(?:FAIL|TIMEOUT)\b/, /^--- FAIL/, /^not ok\b/, /panicked at|^panic:/,
  /(?<![-/.\w])(?:error|Error|ERROR)\b/, /\bfailed:|\bfailed lanes\b|\(exit [1-9]\d*\)|exited with [1-9]/,
  /disk quota exceeded|No space left on device|errno:? (?:28|122)\b|ENOSPC|EDQUOT/i,
];
export function failureLine(text) {
  const line = text.replace(LANE, '');
  if (/^(?:PASS|RUN) /.test(line)) return false;
  const message = /^STEP \S+ [^:]*: ([^]*)$/.exec(line)?.[1] ?? line;
  return FAILURE.some(pattern => pattern.test(message));
}

// failures는 target 출력 줄을 받아 실패를 모은다. case runner(tests/testcase.mjs, internal/testcase, PHP와 Rust의
// testcase)는 case마다 `RUN <case>`, `STEP <case> ...`, `PASS <case>`나 `FAIL <case> ...: <이유>`를 쓴다. 끝나지
// 않은 case(기한 초과로 멈춘 process, 죽은 process)는 RUN 뒤에 결과가 없으므로 그 case와 마지막 단계를 적는다.
// lane 접두사가 붙은 줄도 같은 case 줄로 읽는다.
// REPORT는 test framework가 실패를 source 위치와 함께 적은 줄이다(Go의 `    stress_test.go:80: <message>`). Go
// testcase는 그런 줄 뒤에 `FAIL <case> ...: the errors reported above`만 쓰므로, 그 FAIL 줄의 이유는 앞의 줄에 있다.
const REPORT = /^\s*[\w./-]+\.(?:go|rs|php|m?js|ts):\d+(?::\d+)?: \S/;
// innermost는 lane 접두사와 겹친 단계 접두사(`STEP <case> elapsed=<경과>: `, runner 안의 runner가 붙인다)를 뗀 message다.
function innermost(text) {
  let line = text.replace(LANE, '');
  for (let next; (next = line.replace(/^STEP .*? elapsed=\S+: /, '')) !== line;) line = next;
  return line;
}

export function failures() {
  const failed = [];
  const open = new Map();
  const tail = [];
  // reports는 지금 case의 source 위치 보고 줄이다. `the errors reported above`인 FAIL 줄 앞에 첫 실패 줄로 넣는다:
  // 출력이 길어 log가 가운데를 줄여도 그 이유가 보고서와 summary에 남는다.
  const reports = [];
  // starts는 열린 case마다 그 RUN 줄 때의 실패 줄 수다. case가 PASS로 끝나면 그 사이에 모인 줄은 그 case의 출력(검사하는
  // 대상이 일부러 실패시킨 sample 같은 것)이지 target의 실패가 아니므로 버린다. 그래서 그 뒤의 진짜 실패가 첫 실패 줄이 된다.
  const starts = new Map();
  let exit = null;
  return {
    // exit는 명령이 끝난 방식이다(종료 코드나 signal). 실패 줄이 없는 실패는 출력의 끝과 이것을 적는다.
    exit(text) {
      exit = text;
    },
    line(text) {
      tail.push(text);
      if (tail.length > FAILURE_LINES) tail.shift();
      const line = text.replace(LANE, '');
      const lane = text.slice(0, text.length - line.length);
      const run = /^RUN (\S+)/.exec(line);
      if (run) {
        open.set(lane + run[1], null);
        if (!starts.has(lane + run[1])) starts.set(lane + run[1], failed.length);
      }
      const step = /^STEP (\S+) /.exec(line);
      if (step && open.has(lane + step[1])) open.set(lane + step[1], text);
      const done = /^(PASS|FAIL|TIMEOUT) (\S+)/.exec(line);
      if (done) {
        open.delete(lane + done[2]);
        if (done[1] === 'PASS' && starts.has(lane + done[2])) failed.splice(starts.get(lane + done[2]));
        starts.delete(lane + done[2]);
      }
      const inner = innermost(text);
      if (/^(?:=== RUN|RUN |PASS |--- PASS)/.test(inner)) reports.length = 0;
      else if (REPORT.test(inner) && !failureLine(text)) {
        reports.push(text);
        if (reports.length > FAILURE_LINES) reports.shift();
      }
      if (failureLine(text) && /the errors reported above$/.test(inner)) {
        failed.push(...reports);
        reports.length = 0;
      }
      if (failureLine(text)) failed.push(text);
    },
    // lines는 실패한 target의 첫 실패 줄이다: 나온 순서대로의 실패와 오류 수준의 줄, 끝나지 않은 case, 둘 다 없으면
    // 출력의 마지막 줄들, 그리고 명령이 끝난 방식.
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

// SPACE는 공간이 없어 실패한 줄이다: ENOSPC(errno 28)와 EDQUOT(errno 122).
export const SPACE = /disk quota exceeded|No space left on device|errno:? (?:28|122)\b|ENOSPC|EDQUOT/i;

// output은 명령 하나의 출력이다. 명령이 없거나 실패하면 그 사실을 출력으로 돌려준다.
function output(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return `${program}: ${result.error.code ?? result.error.message}\n`;
  return `${result.stdout}${result.stderr}${result.status ? `${program} exited with ${result.status}\n` : ''}`;
}

// diskSnapshot은 실행의 공간을 적는다: `/`, `/tmp`, process의 임시 directory(TMPDIR)와 보고서의 file system마다 df,
// /tmp의 mount option(findmnt: tmpfs의 size와 quota), /tmp와 실행 directory(.runtime/run, .runtime/check/<run id>)의
// 큰 항목, 그리고 지웠지만 process가 열어 둔 /tmp의 file(lsof +L1). places는 그 줄마다 남은 공간(KiB)이다. 어느
// 명령이 없으면 그 사실이 출력이다.
export function diskSnapshot(root, run) {
  const temporary = [...new Set(['/tmp', tmpdir()])];
  const filesystems = [...new Set(['/', ...temporary, run])];
  // df는 path마다 따로 읽는다. 없는 path는 places에 들지 않고 그 오류가 출력에 남는다.
  const places = {};
  const df = filesystems.map(path => {
    const text = output('df', ['-k', path]);
    const row = text.trim().split('\n').find(line => /^\S+\s+\d+\s+\d+\s+\d+\s/.test(line));
    if (row) places[path] = Number(row.trim().split(/\s+/)[3]);
    return text;
  }).join('');
  const largest = directory => output('sh', ['-c', `du -sxk ${JSON.stringify(directory)}/* ${JSON.stringify(directory)}/.[!.]* 2>/dev/null | sort -rn | head -20`]);
  const text = [
    `## df -k ${filesystems.join(' ')}`, df,
    '## findmnt /tmp', output('findmnt', ['-no', 'SOURCE,FSTYPE,SIZE,USED,AVAIL,OPTIONS', '/tmp']),
    ...temporary.flatMap(directory => [`## the largest entries of ${directory} (KiB)`, largest(directory)]),
    '## the largest entries of .runtime/run (KiB)', largest(resolve(root, '.runtime/run')),
    `## the largest entries of ${run} (KiB)`, largest(run),
    '## files under /tmp that were removed but are still open (lsof +L1)', output('sh', ['-c', 'lsof +L1 2>/dev/null | awk \'NR == 1 || /\\/tmp\\//\' | head -40']),
  ].join('\n');
  return { text, places };
}

// DISK_IO는 SQLite가 file을 쓰지 못한 줄이다(SQLITE_IOERR, 그 쓰기 형태 778). 공간이 없을 때도 나오지만 다른 원인도
// 있으므로, 그 순간의 기록에서 file system 하나가 남은 공간 0일 때만 공간 부족으로 적는다.
export const DISK_IO = /disk I\/O error|\(code: 778\)|SQLITE_IOERR/;

// spaceLine은 공간이 없어 실패한 target의 첫 실패 줄이다: 실패 원인과 그 순간의 남은 공간, /tmp의 가장 큰 항목, 그리고
// 지웠지만 process가 열어 둔 가장 큰 file이다. 지운 file은 du에 보이지 않으므로 그것이 공간을 채운 것일 때 따로 적는다.
export function spaceLine(snapshot, cause = 'ENOSPC or EDQUOT') {
  const free = Object.entries(snapshot.places).map(([place, kib]) => `${place} ${(kib / 1024 ** 2).toFixed(2)} GiB free`).join(', ');
  const tmp = /## the largest entries of \/tmp \(KiB\)\n([^#]*)/.exec(snapshot.text)?.[1].trim().split('\n').slice(0, 3).map(line => line.trim().replace(/\s+/, ' KiB ')).join('; ');
  const open = (/\(lsof \+L1\)\n([^#]*)/.exec(snapshot.text)?.[1] ?? '').split('\n').map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 11 && /^\d+$/.test(fields[6]) && fields.at(-1) === '(deleted)')
    .sort((a, b) => Number(b[6]) - Number(a[6]))[0];
  const removed = open ? `; the largest removed but open file: ${(Number(open[6]) / 1024 ** 2).toFixed(1)} MiB by lsof SIZE/OFF, ${open.slice(9, -1).join(' ')} (${open[0]} ${open[1]})` : '';
  return `out of space: the target failed with ${cause}; ${free}; the largest under /tmp: ${tmp || 'none listed'}${removed}`;
}

// spaceCause는 실패한 target의 첫 실패 줄 앞에 둘 공간 부족 줄이다. ENOSPC나 EDQUOT 줄이 있으면 언제나, SQLite의 disk
// I/O error 줄은 그 순간 남은 공간이 0인 file system이 있을 때만이다. 둘 다 아니면 null이다.
export function spaceCause(lines, snapshot) {
  if (lines.some(line => SPACE.test(line))) return spaceLine(snapshot);
  const full = Object.entries(snapshot.places).filter(([, kib]) => kib === 0).map(([place]) => place);
  if (full.length && lines.some(line => DISK_IO.test(line))) return spaceLine(snapshot, `a disk I/O error while ${full.join(', ')} had no free space`);
  return null;
}

// NPM_LOG는 npm이 자기 debug log의 경로를 적는 줄이다. 그 log는 보고서 밖(~/.npm/_logs)에 있다.
export const NPM_LOG = /A complete log of this run can be found in:\s*(\S+)/;

// npmErrors는 npm debug log의 오류 줄(`<n> error <message>`)에서 message를 처음부터 5개 돌려준다.
export function npmErrors(text) {
  return text.split('\n').map(line => /^\d+ error (.*)$/.exec(line)?.[1]).filter(message => message && !NPM_LOG.test(message)).slice(0, 5);
}

// keepFile은 file 하나를 보고서로 옮긴다. LIMIT_BYTES보다 크면 끝만 남기고 그 사실을 첫 줄에 적는다.
export function keepFile(source, destination) {
  const { size } = statSync(source);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  if (size > LIMIT_BYTES) writeFileSync(destination, Buffer.concat([Buffer.from(`[the last ${TAIL_BYTES} of ${size} bytes of ${source}]\n`), tail(source, size)]));
  else writeFileSync(destination, readFileSync(source));
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

// keepLogs는 directory 바로 아래의 `*.log` file(test server의 log)을 보고서로 옮긴다. LIMIT_BYTES보다 큰 file은 끝만
// 남긴다. data directory는 읽지 않는다. 옮긴 file 수를 돌려준다.
export function keepLogs(source, destination) {
  if (!existsSync(source)) return 0;
  let kept = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const path = join(source, entry.name);
    const { size } = statSync(path);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, entry.name), size > LIMIT_BYTES
      ? Buffer.concat([Buffer.from(`[the last ${TAIL_BYTES} of ${size} bytes of ${path}]\n`), tail(path, size)])
      : readFileSync(path));
    kept++;
  }
  return kept;
}

// cappedLog는 단계 하나의 log다. 쓴 크기가 LIMIT_BYTES에 이르면 file에는 더 쓰지 않고 마지막 TAIL_BYTES만 memory에
// 두었다가 close가 `[... <n> bytes of output omitted; the last <m> bytes follow ...]`와 함께 붙인다. 그래서 log는 실행
// 중에도 LIMIT_BYTES와 TAIL_BYTES를 넘지 않고, 머리(명령, recipe, 입력, 처음 출력)와 끝을 모두 가진다. 쓰기는
// writer(reportWriter)가 한다. close는 생략한 byte 수를 돌려준다.
export function cappedLog(writer, path, header) {
  let size = 0;
  let omitted = 0;
  let tail = [];
  let tailSize = 0;
  const write = text => {
    const bytes = Buffer.byteLength(text);
    if (size + bytes <= LIMIT_BYTES) {
      writer.append(path, text);
      size += bytes;
      return;
    }
    omitted += bytes;
    tail.push(text);
    tailSize += bytes;
    while (tailSize - Buffer.byteLength(tail[0]) >= TAIL_BYTES) tailSize -= Buffer.byteLength(tail.shift());
  };
  writer.write(path, header);
  size = Buffer.byteLength(header);
  return {
    line: text => write(`${text}\n`),
    close() {
      if (!omitted) return 0;
      const kept = tail.join('');
      writer.append(path, `[... ${omitted - Buffer.byteLength(kept)} bytes of output omitted; the last ${Buffer.byteLength(kept)} bytes follow ...]\n${kept}`);
      return omitted - Buffer.byteLength(kept);
    },
  };
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
  if (run.reason) lines.push('```', run.reason, '```', '');
  if (report) lines.push(`Report: \`${report}\` (environment.txt, targets/<target>.log, targets/<target>/run/). A target log keeps its first ${LIMIT_BYTES} bytes and its last ${TAIL_BYTES} bytes and states the bytes it omits; a kept file larger than ${LIMIT_BYTES} bytes keeps only its last ${TAIL_BYTES} bytes, which its first line states.`, '');
  lines.push('| step | status | time | first failure lines |', '|---|---|---|---|');
  for (const step of steps) {
    const detail = step.status === 'not-run' ? step.reason : [...(step.failures ?? []).slice(0, 3), ...(step.reportErrors ?? [])].join(' / ');
    lines.push(`| ${escape(step.name)} | ${step.status} | ${time(step)} | ${escape(detail ?? '')} |`);
  }
  const writes = [...(run.reportErrors ?? []), ...steps.flatMap(step => step.reportErrors ?? [])];
  if (writes.length) lines.push('', '## report write failures', '', '```', ...writes, '```');
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
