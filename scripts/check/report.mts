// The report of one full-suite run (.runtime/check/<run id>/report). Before the next CI run, one CI run has to gather
// enough information to fix every failure it finds, so rather than rerunning per failure, it keeps what can be diagnosed
// it keeps:
//
//   environment.txt          the run's environment: commit and tree, OS, versions of tools and servers, disk
//   targets/<target>.log     the target's exact command, its Makefile recipe, input paths, and the full output
//   targets/<target>/run/    files from the run directory (.runtime/run/<target>-<pid>) left by a failed target
//   summary.md               per target: status, time, first failure line. In CI it is also written to GITHUB_STEP_SUMMARY
//   record.json              that run's record from .runtime/full-run.json (written by the CI summary step)
//   servers/*.log            test server logs (written by the CI summary step)
//
// A target log keeps the first LIMIT_BYTES and the last TAIL_BYTES (cappedLog), and among the files it moves, any file larger than LIMIT_BYTES
// keeps only its last TAIL_BYTES and notes that in the file's first line and in the summary. The build
// target (`target` directory), node_modules, and database files are not moved; they are listed with their sizes in the manifest.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { errorCode, errorMessage } from '../../tests/errors.mts';

/** One step of a check run as its record holds it. */
export type StepRecord = { name: string; status: string; elapsed?: number; started?: string | null; ended?: string | null; failures?: string[]; reportErrors?: string[]; warnings?: string[]; reason?: string; log?: string; disk?: Record<string, number>; truncated?: number | null };
/** A check run as its record holds it: a full run, or one rerun of it. */
export type RunRecord = { id?: string; commit?: string; tree?: string; started?: string; ended?: string | null; result?: string; reason?: string; setup?: StepRecord[]; reportErrors?: string[]; targets: StepRecord[]; failed?: string[]; incomplete?: string[]; report?: string; disk?: Record<string, number> };
/** The writer of a report; every write is attempted and a failure is collected, never thrown. */
export type ReportWriter = { failed: string[]; write: (path: string, text: string) => boolean; append: (path: string, text: string) => boolean; run: (path: string, action: () => void) => boolean };
/** The free space and the commands output of a disk snapshot. */
export type DiskSnapshot = { text: string; places: Record<string, number> };

export const LIMIT_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
// FAILURE_LINES is the number of first failure lines that the summary and the record keep per target.
export const FAILURE_LINES = 20;
const SKIPPED_DIRECTORIES = new Set(['target', 'node_modules', '.git']);
const DATABASE_FILE = /\.(sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db|ibd)$/;

export const reportDirectory = (root: string, id: string): string => resolve(root, '.runtime/check', id, 'report');

// reportWriter handles every write to the report. Writes do not throw: on failure, `report write failed: <path>: <code>
// <message>` is collected into failed and false is returned. The runner puts it into the step record and the summary and exits with 1. A missing
// directory is not recreated: if the report directory disappeared during the run, that fact must remain as a failure.
export function reportWriter(): ReportWriter {
  const failed: string[] = [];
  const attempt = (path: string, action: () => void) => {
    try {
      action();
      return true;
    } catch (error) {
      failed.push(`report write failed: ${path}: ${errorCode(error) ?? (error instanceof Error ? error.name : 'Error')}: ${errorMessage(error)}`);
      return false;
    }
  };
  return {
    failed,
    write: (path: string, text: string) => attempt(path, () => writeFileSync(path, text)),
    append: (path: string, text: string) => attempt(path, () => appendFileSync(path, text)),
    // run executes the other report-writing tasks (environment, keeping run directories, shrinking logs) under the same rule.
    run: (path: string, action: () => void) => attempt(path, action),
  };
}

// failureLine tells whether a line is failure or error-level output. It strips the lane prefix at the start of the line (`[rust] `, the parallel lanes of client-db-test) and GitHub's
// annotation (`##[error]`) before checking. A line that reports a pass or a start (PASS, RUN) is not a failure even if it contains an error word. A step
// line (`STEP <case> elapsed=...: <message>`) is judged by its message, not by the case name, and the error word in `driver-error/...`
// is counted only when it is not part of a longer name (preceded by `-`, `/`, `.`, or letters).
const LANE = /^(?:##\[\w+\])?(?:\[[\w-]+\] )?/;
const FAILURE = [
  /^(?:FAIL|TIMEOUT)\b/, /^--- FAIL/, /^not ok\b/, /panicked at|^panic:/,
  /(?<![-/.\w])(?:error|Error|ERROR)\b/, /\bfailed:|\bfailed lanes\b|\(exit [1-9]\d*\)|exited with [1-9]/,
  /disk quota exceeded|No space left on device|errno:? (?:28|122)\b|ENOSPC|EDQUOT/i,
];
export function failureLine(text: string): boolean {
  const line = text.replace(LANE, '');
  if (/^(?:PASS|RUN) /.test(line)) return false;
  const message = /^STEP \S+ [^:]*: ([^]*)$/.exec(line)?.[1] ?? line;
  return FAILURE.some(pattern => pattern.test(message));
}

// failures takes the target's output lines and collects the failures. The case runners (tests/testcase.mts, packages/go/testcase, and the PHP and Rust
// testcase) write `RUN <case>`, `STEP <case> ...`, and `PASS <case>` or `FAIL <case> ...: <reason>` for each case. A case that does not finish
// (a process stopped for exceeding its deadline, or a dead process) has no result after RUN, so its case and last step are recorded.
// A line with a lane prefix is also read as the same case line.
// REPORT is a line in which the test framework records a failure with its source location (Go's `    stress_test.go:80: <message>`). Go
// testcase writes only `FAIL <case> ...: the errors reported above` after such a line, so the reason for that FAIL line is in the earlier line.
const REPORT = /^\s*[\w./-]+\.(?:go|rs|php|m?[jt]s):\d+(?::\d+)?: \S/;
// innermost is the message with the lane prefix and the overlapping step prefix removed (`STEP <case> elapsed=<elapsed>: `, added by a runner inside a runner).
function innermost(text: string): string {
  let line = text.replace(LANE, '');
  for (let next; (next = line.replace(/^STEP .*? elapsed=\S+: /, '')) !== line;) line = next;
  return line;
}

/** The failures of one target's output, line by line. */
export type Failures = { warnings: () => string[]; exit: (text: string) => void; line: (text: string) => void; lines: () => string[] };

export function failures(): Failures {
  const failed: string[] = [];
  const open = new Map<string, string | null>();
  const tail: string[] = [];
  // reports is the source-location report line of the current case. It is put in as the first failure line before a FAIL line that reads `the errors reported above`:
  // even when the output is so long that the log shrinks its middle, the reason stays in the report and the summary.
  const reports: string[] = [];
  // starts holds, for each open case, the number of failure lines at the time of its RUN line. If the case ends with PASS, the lines collected in between are that case's output (for example a sample
  // that the subject deliberately makes fail), not a failure of the target, so they are discarded. That way, the real failure after them becomes the first failure line.
  const starts = new Map<string, number>();
  // warnings are the lines saying a performance measurement exceeded the document's reference value (`WARNING <message>`, AGENTS.md). Since they are not failures, they do not go into the first failure line
  // and are recorded separately in the run record and the summary.
  const warnings: string[] = [];
  let exit: string | null = null;
  return {
    warnings: () => [...warnings],
    // exit is how the command ended (exit code or signal). A failure with no failure line is recorded with the end of its output and this.
    exit(text: string): void {
      exit = text;
    },
    line(text: string): void {
      tail.push(text);
      if (tail.length > FAILURE_LINES) tail.shift();
      const line = text.replace(LANE, '');
      const lane = text.slice(0, text.length - line.length);
      const run = /^RUN (\S+)/.exec(line);
      if (run) {
        const name = lane + (run[1] ?? '');
        open.set(name, null);
        if (!starts.has(name)) starts.set(name, failed.length);
      }
      const step = /^STEP (\S+) /.exec(line);
      if (step && open.has(lane + (step[1] ?? ''))) open.set(lane + (step[1] ?? ''), text);
      const done = /^(PASS|FAIL|TIMEOUT) (\S+)/.exec(line);
      if (done) {
        const name = lane + (done[2] ?? '');
        open.delete(name);
        const start = starts.get(name);
        if (done[1] === 'PASS' && start !== undefined) failed.splice(start);
        starts.delete(name);
      }
      const inner = innermost(text);
      const warned = /^WARNING (.+)$/.exec(inner);
      if (warned) warnings.push(warned[1] ?? '');
      if (/^(?:=== RUN|RUN |PASS |--- PASS)/.test(inner)) reports.length = 0;
      else if (REPORT.test(inner) && !failureLine(text)) {
        reports.push(text);
        if (reports.length > FAILURE_LINES) reports.shift();
      }
      if (failureLine(text) && inner.endsWith('the errors reported above')) {
        failed.push(...reports);
        reports.length = 0;
      }
      if (failureLine(text)) failed.push(text);
    },
    // lines are the first failure lines of a failed target: its failures and error-level lines in the order they appeared, and unfinished cases; if neither exists,
    // the last lines of the output, and how the command ended.
    lines(): string[] {
      const pending = [...open].map(([name, last]) => `case ${name} did not finish; its last step: ${last ?? 'none (it reported no step)'}`);
      const lines = [...failed, ...pending].slice(0, FAILURE_LINES);
      return [...(lines.length ? lines : tail), ...(exit ? [exit] : [])];
    },
  };
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  if (result.error) return `${program}: ${errorCode(result.error) ?? result.error.message}`;
  return `${(result.stdout || result.stderr).trim().split('\n')[0]}`;
}

// environment records the run's environment, so that when a failed case differs from the expected value because of the environment, it can be seen without rerunning
// the versions and disk are kept.
export function writeEnvironment(root: string, report: string, extra: Record<string, string> = {}): void {
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

// SPACE is a line that failed for lack of space: ENOSPC (errno 28) and EDQUOT (errno 122).
export const SPACE = /disk quota exceeded|No space left on device|errno:? (?:28|122)\b|ENOSPC|EDQUOT/i;

// output is the output of one command. If the command is absent or fails, it returns that fact as the output.
function output(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return `${program}: ${errorCode(result.error) ?? result.error.message}\n`;
  return `${result.stdout}${result.stderr}${result.status ? `${program} exited with ${result.status}\n` : ''}`;
}

// diskSnapshot records the space of the run: df for each of `/`, `/tmp`, the process's temporary directory (TMPDIR), and the file system of the report,
// the mount options of /tmp (findmnt: the size and quota of tmpfs), and of /tmp and the run directories (.runtime/run, .runtime/check/<run id>)
// the large entries, and the /tmp files deleted but still held open by a process (lsof +L1). places is the remaining space (KiB) on each such line. Which
// If a command is absent, that fact is its output.
export function diskSnapshot(root: string, run: string): DiskSnapshot {
  const temporary = [...new Set(['/tmp', tmpdir()])];
  const filesystems = [...new Set(['/', ...temporary, run])];
  // df is read separately for each path. A missing path is not included in places, and its error remains in the output.
  const places: Record<string, number> = {};
  const df = filesystems.map(path => {
    const text = output('df', ['-k', path]);
    const row = text.trim().split('\n').find(line => /^\S+\s+\d+\s+\d+\s+\d+\s/.test(line));
    if (row) places[path] = Number(row.trim().split(/\s+/)[3]);
    return text;
  }).join('');
  const largest = (directory: string) => output('sh', ['-c', `du -sxk ${JSON.stringify(directory)}/* ${JSON.stringify(directory)}/.[!.]* 2>/dev/null | sort -rn | head -20`]);
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

// DISK_IO is the line in which SQLite could not write a file (SQLITE_IOERR, that write form 778). It also appears when space is out, but other causes exist too,
// so it is recorded as out of space only when a file system has 0 bytes free in that moment's record.
export const DISK_IO = /disk I\/O error|\(code: 778\)|SQLITE_IOERR/;

// spaceLine is the first failure line of a target that failed for lack of space: the failure cause and the free space at that moment, the largest item in /tmp, and
// the largest file that was deleted but is still held open by a process. A deleted file is not visible to du, so when it is what filled the space, it is recorded separately.
export function spaceLine(snapshot: DiskSnapshot, cause = 'ENOSPC or EDQUOT'): string {
  const free = Object.entries(snapshot.places).map(([place, kib]) => `${place} ${(kib / 1024 ** 2).toFixed(2)} GiB free`).join(', ');
  const tmp = /## the largest entries of \/tmp \(KiB\)\n([^#]*)/.exec(snapshot.text)?.[1]?.trim().split('\n').slice(0, 3).map(line => line.trim().replace(/\s+/, ' KiB ')).join('; ');
  const open = (/\(lsof \+L1\)\n([^#]*)/.exec(snapshot.text)?.[1] ?? '').split('\n').map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 11 && /^\d+$/.test(fields[6] ?? '') && fields.at(-1) === '(deleted)')
    .sort((a, b) => Number(b[6]) - Number(a[6]))[0];
  const removed = open ? `; the largest removed but open file: ${(Number(open[6]) / 1024 ** 2).toFixed(1)} MiB by lsof SIZE/OFF, ${open.slice(9, -1).join(' ')} (${open[0]} ${open[1]})` : '';
  return `out of space: the target failed with ${cause}; ${free}; the largest under /tmp: ${tmp || 'none listed'}${removed}`;
}

// spaceCause is the out-of-space line placed before the first failure line of a failed target. Whenever there is an ENOSPC or EDQUOT line, and for SQLite's disk
// I/O error line only when a file system has 0 bytes free at that moment. If neither applies, it is null.
export function spaceCause(lines: string[], snapshot: DiskSnapshot): string | null {
  if (lines.some((line: string) => SPACE.test(line))) return spaceLine(snapshot);
  const full = Object.entries(snapshot.places).filter(([, kib]) => kib === 0).map(([place]) => place);
  if (full.length && lines.some((line: string) => DISK_IO.test(line))) return spaceLine(snapshot, `a disk I/O error while ${full.join(', ')} had no free space`);
  return null;
}

// NPM_LOG is the line where npm writes the path of its debug log. That log is outside the report (~/.npm/_logs).
export const NPM_LOG = /A complete log of this run can be found in:\s*(\S+)/;

// npmErrors returns the first 5 messages from the error lines of the npm debug log (`<n> error <message>`).
export function npmErrors(text: string): string[] {
  return text.split('\n').map((line: string) => /^\d+ error (.*)$/.exec(line)?.[1]).filter((message): message is string => message !== undefined && message !== '' && !NPM_LOG.test(message)).slice(0, 5);
}

// keepFile moves one file into the report. If it is larger than LIMIT_BYTES, only its end is kept, and the first line says so.
export function keepFile(source: string, destination: string): void {
  const { size } = statSync(source);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  if (size > LIMIT_BYTES) writeFileSync(destination, Buffer.concat([Buffer.from(`[the last ${TAIL_BYTES} of ${size} bytes of ${source}]\n`), tail(source, size)]));
  else writeFileSync(destination, readFileSync(source));
}

// tail reads the last TAIL_BYTES of a file.
function tail(path: string, size: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    readSync(descriptor, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

// keepRunDirectory moves the run directory left by a failed target into the report. A file larger than LIMIT_BYTES keeps only its end,
// build targets, node_modules, database files, and binary files are not moved; the manifest records the reason and size.
export function keepRunDirectory(source: string, destination: string): number {
  const manifest: string[] = [];
  const walk = (directory: string) => {
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

// keepLogs moves the `*.log` files directly under the directory (the test server logs) into the report. A file larger than LIMIT_BYTES keeps only its end,
// The data directory is not read. It returns the number of files moved.
export function keepLogs(source: string, destination: string): number {
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

// cappedLog is the log of one step. Once the written size reaches LIMIT_BYTES, nothing more is written to the file; only the last TAIL_BYTES are kept in memory
// and close appends them with `[... <n> bytes of output omitted; the last <m> bytes follow ...]`. So the log, during the run,
// never exceeds LIMIT_BYTES and TAIL_BYTES, and has both its head (command, recipe, inputs, first output) and its end. Writing is
// done by the writer (reportWriter). close returns the number of bytes omitted.
export function cappedLog(writer: ReportWriter, path: string, header: string): { line: (text: string) => void; close: () => number } {
  let size = 0;
  let omitted = 0;
  const tail: string[] = [];
  let tailSize = 0;
  const write = (text: string) => {
    const bytes = Buffer.byteLength(text);
    if (size + bytes <= LIMIT_BYTES) {
      writer.append(path, text);
      size += bytes;
      return;
    }
    omitted += bytes;
    tail.push(text);
    tailSize += bytes;
    while (tail.length && tailSize - Buffer.byteLength(tail[0] ?? '') >= TAIL_BYTES) tailSize -= Buffer.byteLength(tail.shift() ?? '');
  };
  writer.write(path, header);
  size = Buffer.byteLength(header);
  return {
    line: (text: string) => write(`${text}\n`),
    close(): number {
      if (!omitted) return 0;
      const kept = tail.join('');
      writer.append(path, `[... ${omitted - Buffer.byteLength(kept)} bytes of output omitted; the last ${Buffer.byteLength(kept)} bytes follow ...]\n${kept}`);
      return omitted - Buffer.byteLength(kept);
    },
  };
}

const time = (step: StepRecord): string => step.elapsed !== undefined ? `${(step.elapsed / 1000).toFixed(1)} s`
  : step.started && step.ended ? `${((Date.parse(step.ended) - Date.parse(step.started)) / 1000).toFixed(1)} s` : '';
const escape = (text: string) => String(text).replaceAll('|', '\\|');

// summary builds summary.md from the record. run is the run of the record (the record itself for a full run, or that re-run for a re-run),
// if crashed is a string, it is the reason the runner did not finish, and the record at that point is the last state the runner wrote.
export function summary(record: RunRecord, { run = record, report, crashed = null }: { run?: RunRecord; report?: string | undefined; crashed?: string | null } = {}): string {
  const steps = [...(run.setup ?? []), ...record.targets];
  const count = (status: string) => steps.filter(step => step.status === status).length;
  const lines = [
    `# make orm-check ${run.id ?? ''}`.trim(),
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
  // Warnings are not failures: the step where a performance measurement exceeded the document's reference value, and its line, are recorded separately.
  const warned = steps.filter(step => step.warnings?.length);
  if (warned.length) {
    lines.push('', '## warnings', '', 'A warning is no failure: a measurement exceeded its documented reference value (AGENTS.md).', '');
    for (const step of warned) for (const warning of step.warnings ?? []) lines.push(`- ${escape(step.name)}: ${warning}`);
  }
  for (const step of steps.filter(step => step.status === 'failed' && step.failures?.length)) {
    lines.push('', `## ${step.name}`, '', `log: \`${step.log ?? ''}\``, '', '```', ...(step.failures ?? []), '```');
  }
  return `${lines.join('\n')}\n`;
}

// publish writes the summary into the report. The CI summary step (scripts/check/summary.mts) also writes to GITHUB_STEP_SUMMARY.
export function publish(text: string, report: string | undefined, { step = false }: { step?: boolean } = {}): void {
  if (report) {
    mkdirSync(report, { recursive: true });
    writeFileSync(join(report, 'summary.md'), text);
  }
  if (step && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

// runName builds the run's name from ORM_CHECK_RUN_ID. The name is also used in database names, so it consists of lowercase letters, digits, and underscores.
export const runName = (id: string): string => `ci_${id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
