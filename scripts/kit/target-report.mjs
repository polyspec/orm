// The report of a run of make targets, so that one CI run leaves the reason of every failure:
//
//   <directory>/targets/<target>.log   the output of `make -k <target>`; a log above LIMIT_BYTES keeps its head and its tail
//   <directory>/record.json            the tree, the toolchain versions, and each target with its status, times, first
//                                      failure lines and warnings; written before and after each target, so a run that
//                                      stops leaves the target that was running
//   <directory>/summary.md             the same as a page, also appended to the job summary of GitHub Actions
//
// A write of the report never throws: it is printed, recorded in `reportErrors` of the record, and the run fails after every
// target ran. A report file is written to a temporary file and renamed.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './files.mjs';
import { git } from './git.mjs';
import { seconds } from './time.mjs';

// The number of failure lines of a failed target in the record and the summary.
export const FAILURE_LINES = 20;
// A log above this size keeps its first part and its last TAIL_BYTES, so that a report stays small enough to upload.
export const LIMIT_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
// The variables of a calling make, which a target of the run must not inherit.
const CALLER = ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES'];

// A target name is a word of letters, digits, dots, underscores and hyphens that starts with a letter or a digit, so it names its log file without escaping and make takes it for a target.
export const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const logPath = (directory, target) => path.join(directory, 'targets', `${target}.log`);

/** The id of the tree of HEAD in `root`, or `unknown (<reason>)`. */
export function treeId(root) {
  try {
    return git(root, 'rev-parse', 'HEAD^{tree}').trim();
  } catch (error) {
    return `unknown (${error.message})`;
  }
}

/** A writer of report files that never throws: a failed write is printed and kept in `errors`. */
export function reportWriter(print) {
  const errors = [];
  const attempt = (file, action) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      action();
    } catch (error) {
      const message = `report write failed: ${file}: ${error.code ?? error.message}`;
      errors.push(message);
      print(`[report] ${message}`);
    }
  };
  return {
    errors,
    write: (file, text) => attempt(file, () => {
      writeAtomic(file, text);
    }),
    append: (file, text) => attempt(file, () => appendFileSync(file, text)),
  };
}

/** Starts the report of a run: the directory holds only the files of this run. */
export function startReport(directory) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.join(directory, 'targets'), { recursive: true });
}

/** Cuts the log at `file` above LIMIT_BYTES to its head and its last TAIL_BYTES, with a line that says so. */
export function capLog(file, limit = LIMIT_BYTES, tail = TAIL_BYTES) {
  const size = statSync(file).size;
  if (size <= limit) return false;
  const bytes = readFileSync(file);
  const head = bytes.subarray(0, limit - tail);
  const rest = bytes.subarray(size - tail);
  writeFileSync(file, Buffer.concat([head, Buffer.from(`\n[report] ${size - limit} bytes of the output are left out here; the first ${head.length} and the last ${tail} bytes are kept\n`), rest]));
  return true;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// A line that states a failure: a failed test, an error, a failed check of a recipe, a refusal, a panic or a full disk, and
// the line of a checker that names a file (`docs/a.md:3:1: rule: message`). A line that reports a pass, such as
// `✔ ... 0 failed`, or the start of a test, is not one.
const FAILURE = [
  /^(?:FAIL|TIMEOUT)\b/, /^not ok\b/, /✖/, /panicked at|^panic:/, /^Traceback\b/,
  /(?<![-/.\w])(?:error|Error|ERROR)\b/,
  /\b[1-9]\d* failed\b|failed checks:|\bfailed:|exited with (?:code |status )?[1-9]/,
  /\brefused\b|\bmismatch\b|\bstale\b|\bexpected\b|\bdiffers?\b/,
  /^(?:\[[\w-]+\] )?[\w./@-]+\.\w+(?::\d+){0,2}: \S/,
  /No space left on device|ENOSPC|EDQUOT/,
];
const PASSING = /✔|\bok \(\d+ ms\)$|test result: ok\.|^(?:\[\s*[\d.]+s\] )?▶ |^make(?:\[\d+\])?: (?:Entering|Leaving) directory/;
// The lines in which make names a failed recipe are left to the last lines, because the exit line of the target states the same.
const MAKE_LINE = /^make(?:\[\d+\])?: (?:\*\*\*|Target .* not remade)/;
const WARNING = /^WARNING /;

/**
 * The first failure lines of a failed target, then `exit`, how make ended. When a test reporter marked failures with `✖`,
 * they are the marked lines with the indented detail lines that follow each, because other lines that hold an error word, such
 * as the output of a passing test that starts a failing server, are not the failure. Otherwise they are the lines that state a
 * failure in their order, else the last lines. At most FAILURE_LINES lines.
 */
export function failureLines(lines, exit) {
  const plain = lines.map(line => line.replace(ANSI, ''));
  const marked = [];
  let detail = false;
  for (const line of plain) {
    if (/✖/.test(line)) {
      marked.push(line);
      detail = true;
    } else if (detail && /^\s+\S/.test(line)) marked.push(line);
    else detail = false;
  }
  if (marked.length) return [...marked.slice(0, FAILURE_LINES), exit];
  const failed = plain.filter(line => !PASSING.test(line) && !MAKE_LINE.test(line) && FAILURE.some(pattern => pattern.test(line)));
  return [...(failed.length ? failed.slice(0, FAILURE_LINES) : plain.filter(line => line.trim()).slice(-FAILURE_LINES)), exit];
}

/** The lines of a passing target that start with `WARNING `: measured and reported, never a failure. */
export function warningLines(lines) {
  return lines.map(line => line.replace(ANSI, '')).filter(line => WARNING.test(line)).slice(0, FAILURE_LINES);
}

/** Whether the `exit` text that runLogged resolves is a pass of `target`. */
export const targetPassed = (target, exit) => exit === `make ${target} exited with status 0`;

/**
 * Runs `make -k <target>` in `root`, which keeps going after a failed prerequisite, and writes its output to the log file
 * `log` line by line as the lines come. A line is passed on when it is complete, so the output of standard output and of
 * standard error never joins on one line. `output(text, stream)` receives it too. Resolves the lines and how make ended:
 * `make <target> exited with status 0` is a pass.
 */
export function runLogged({ root, target, log, writer, output, make = 'make', env = process.env }) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !CALLER.includes(name)));
    const command = ['--no-print-directory', '-k', target];
    mkdirSync(path.dirname(log), { recursive: true });
    const descriptor = openSync(log, 'w');
    const lines = [];
    const put = (text) => {
      try { writeSync(descriptor, text); } catch (error) { writer.errors.push(`report write failed: ${log}: ${error.code ?? error.message}`); }
    };
    put(`${make} ${command.join(' ')}\n`);
    const child = spawn(make, command, { cwd: root, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
    const pending = { stdout: '', stderr: '' };
    const pass = (name, complete) => {
      if (!complete.length) return;
      const text = `${complete.join('\n')}\n`;
      output(text, name);
      put(text);
      lines.push(...complete);
    };
    const take = name => (data) => {
      const parts = `${pending[name]}${data}`.split('\n');
      pending[name] = parts.pop();
      pass(name, parts);
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    let ended = false;
    const finish = (exit) => {
      if (ended) return;
      ended = true;
      for (const name of ['stdout', 'stderr']) {
        if (pending[name] !== '') pass(name, [pending[name]]);
        pending[name] = '';
      }
      put(`[report] ${exit}\n`);
      closeSync(descriptor);
      resolve({ lines, exit });
    };
    child.once('error', error => finish(`make ${target} could not start: ${error.message}`));
    child.once('close', (status, signal) => finish(signal ? `make ${target} ended on ${signal}` : `make ${target} exited with status ${status}`));
  });
}

const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

/**
 * The summary page of a record, or of a run that recorded nothing (`record` null or `{ error }`). `steps` are the results of
 * the setup steps of the job (`toJSON(steps)` of GitHub Actions): each that did not succeed is named.
 */
export function render({ title, record, steps = {} }) {
  const lines = [`# ${title}`, ''];
  const setup = Object.entries(steps).filter(([, step]) => step && typeof step === 'object');
  const failedSetup = setup.filter(([, step]) => step.outcome !== 'success' && step.outcome !== 'skipped');
  if (!record || record.error) {
    lines.push(`**${title} recorded no run**${record?.error ? ` (${record.error})` : ''}: it stopped before its first target, or the step did not run. The log of that step shows why.`, '');
  } else {
    lines.push(`tree \`${record.tree}\`, started ${record.started}, ended ${record.ended ?? 'never'}, result **${record.result}**`, '');
    const running = record.targets.find(target => target.status === 'running');
    if (record.result === 'incomplete') lines.push(`**The runner ended without recording the end of its run; ${running ? `${running.name} was running` : 'no target was running'}.** The targets below are as the runner last recorded them.`, '');
  }
  if (setup.length) {
    lines.push('| setup step | outcome |', '|---|---|', ...setup.map(([id, step]) => `| ${cell(id)} | ${cell(step.outcome)} |`), '');
    for (const [id] of failedSetup) lines.push(`- the setup step ${id} did not succeed; its output is in the job log of that step`);
    if (failedSetup.length) lines.push('');
  }
  if (record && !record.error) {
    const count = (...statuses) => record.targets.filter(target => statuses.includes(target.status)).length;
    const warned = record.targets.flatMap(target => (target.warnings ?? []).map(warning => `- ${target.name}: ${warning}`));
    lines.push(`${count('passed')} of ${record.targets.length} targets passed, ${count('failed')} failed, ${count('running', 'pending')} not finished${warned.length ? `, ${warned.length} warning${warned.length === 1 ? '' : 's'}` : ''}.`, '');
    lines.push('| Target | Result | Time |', '| --- | --- | --- |');
    for (const target of record.targets) lines.push(`| ${cell(target.name)} | ${target.status} | ${seconds(target.elapsedMs)} |`);
    if (record.environment && Object.keys(record.environment).length) {
      lines.push('', '| Toolchain | Version |', '| --- | --- |', ...Object.entries(record.environment).map(([name, version]) => `| ${cell(name)} | ${cell(version)} |`));
    }
    if (warned.length) lines.push('', '## warnings', '', ...warned);
    const errors = record.reportErrors ?? [];
    if (errors.length) lines.push('', '## report write failures', '', '```', ...errors, '```');
    for (const target of record.targets.filter(entry => entry.status === 'failed')) {
      lines.push('', `## ${target.name}: ${target.status}`, '', `Log: ${target.log}`, '', '```', ...(target.failures ?? ['the target wrote no log']).map(line => line.replaceAll('```', "'''")), '```');
    }
  }
  return `${lines.join('\n')}\n`;
}
