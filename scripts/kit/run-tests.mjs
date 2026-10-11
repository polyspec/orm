#!/usr/bin/env node
// The test runner. A test target runs its test tool through this script, which prints each test as it starts, keeps running,
// passes, fails or is skipped, with the elapsed time, and gives every test its own timeout.
//
//   node scripts/kit/run-tests.mjs <tool> [--timeout <seconds>] [--cwd <directory>] [--php-extension <file>] [--venv <directory>]
//       [--results <file> [--inputs <path>]...] [--] [<arguments>]
//
// The arguments after the options of the runner go to the tool. --results writes the record of the run, passed or not, to
// <file> (relative to the checkout root): the counts, each test with its status and elapsed time, the tool, the elapsed time
// of the run and `inputs`, the `inputsDigest` of the --inputs paths (the --cwd directory when none is given), so that a
// check can tell a record of the current files from a stale one.
//
// --venv runs the python tool with the interpreter of a virtual environment, so a package's tests import its own installed
// dependencies. The environment must come from the Python of the checkout: its pyvenv.cfg names var/tools/python-build/python/bin
// as its home (install-tools installs that Python), and it holds no symbolic link (`python -m venv --copies`). Any other
// environment is refused before the tool starts. python-venv.mjs makes such an environment (make python-venv DIR=<directory>).
//
// Tools: node (node --test), vitest, go (go test), cargo (cargo test), phpunit and python (python3 -m unittest). node and
// vitest stop a test at its timeout themselves; for go, cargo, phpunit and python this runner stops the tool when a test
// outlives it. No tool has a time
// limit on a package, a file or a whole run. A run in which no test passed, failed or ran out of time fails, so a selection
// that matches nothing never passes; a file of node tests that registers no test fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProgress } from './test-progress.mjs';
import { signalGroup } from './process-group.mjs';
import { venvProblem } from './python-venv.mjs';
import { toolsPath } from './tool-wrappers.mjs';
import { writeJson } from './files.mjs';
import { isMain, ROOT } from './paths.mjs';
import { inputsDigest } from './tracked-files.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = ['node', 'vitest', 'go', 'cargo', 'phpunit', 'python'];
const USAGE = `Usage: node scripts/kit/run-tests.mjs <${TOOLS.join('|')}> [--timeout <seconds>] [--php-extension <file>] [--venv <directory>] [--cwd <directory>] [--results <file> [--inputs <path>]...] [--] [<arguments>]`;
const DEFAULT_TIMEOUT_SECONDS = 30;
// A line in which a tool reports an error: `error: ...` and `error[E0425]: ...` of cargo and rustc, `fatal error: ...`,
// `panic: ...` of Go and `PHP Fatal error: ...`.
const ERROR_LINE = /^(?:error(?:\[\w+\])?:|fatal error:|panic:|PHP Fatal error:)/i;

// The fix for a tool that cannot start.
const INSTALL = {
  node: () => 'install the Node.js release of .node-version',
  vitest: () => 'run make install',
  go: () => 'run make install-tools, which installs Go into var/tools',
  cargo: () => 'install rustup and run make install, which installs the toolchain of rust-toolchain.toml',
  phpunit: ({ cwd }) => `run composer install in ${path.relative(ROOT, cwd) || '.'}`,
  python: () => 'declare pythonBuild in config/toolchain.json and run make install-tools TOOLS=python, which installs var/tools/bin/python3',
};

export function parseArguments(argv, root = ROOT) {
  const [tool, ...rest] = argv;
  if (!TOOLS.includes(tool)) throw new Error(USAGE);
  const options = { tool, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, cwd: root, args: [], inputs: [] };
  let index = 0;
  for (; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (flag === '--timeout') {
      if (!/^[1-9]\d*$/.test(value ?? '')) throw new Error(USAGE);
      options.timeoutSeconds = Number(value);
    } else if (flag === '--php-extension') {
      if (!value || tool !== 'phpunit') throw new Error(USAGE);
      options.phpExtension = path.resolve(root, value);
    } else if (flag === '--venv') {
      if (!value || tool !== 'python') throw new Error(USAGE);
      options.venv = path.resolve(root, value);
    } else if (flag === '--cwd') {
      if (!value) throw new Error(USAGE);
      options.cwd = path.resolve(root, value);
    } else if (flag === '--results') {
      if (!value) throw new Error(USAGE);
      options.results = path.resolve(root, value);
    } else if (flag === '--inputs') {
      if (!value) throw new Error(USAGE);
      options.inputs.push(value);
    } else break;
  }
  if (options.inputs.length && !options.results) throw new Error(`--inputs needs --results\n${USAGE}`);
  if (options.results && !options.inputs.length) options.inputs.push(path.relative(root, options.cwd) || '.');
  options.args = rest.slice(rest[index] === '--' ? index + 1 : index);
  return options;
}

function splitCargo(args) {
  const index = args.indexOf('--');
  return index === -1 ? { cargo: args, harness: [] } : { cargo: args.slice(0, index), harness: args.slice(index + 1) };
}

/** The command of a tool with its progress and timeout arguments. */
export function toolCommand({ tool, timeoutSeconds, cwd, args, phpExtension, venv }, root = ROOT) {
  const milliseconds = String(timeoutSeconds * 1000);
  switch (tool) {
    case 'node':
      return {
        command: process.execPath,
        // A timed-out test can leave work pending; the process of a file ends when its tests end, and the preload fails a
        // file whose process ends before its module registered every test.
        args: ['--test', '--test-force-exit', `--import=${pathToFileURL(path.join(KIT, 'test-load-check.mjs')).href}`, `--test-timeout=${milliseconds}`, `--test-reporter=${path.join(KIT, 'node-reporter.mjs')}`, '--test-reporter-destination=stdout', ...args],
      };
    case 'vitest':
      // npm writes no bin links, so the runner starts the entry of the vitest package with node.
      return { command: process.execPath, args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', `--testTimeout=${milliseconds}`, `--hookTimeout=${milliseconds}`, `--reporter=${path.join(KIT, 'vitest-reporter.mjs')}`, ...args] };
    case 'go':
      // go test has no limit per test; this runner applies it. -timeout=0 removes the limit of go test on a whole test
      // binary, a package.
      return { command: 'go', args: ['test', '-json', '-count=1', '-timeout=0', ...args] };
    case 'cargo':
      // One test at a time, so each test prints its start before its result.
      return { command: 'cargo', args: ['test', ...splitCargo(args).cargo, '--', '--test-threads=1', ...splitCargo(args).harness] };
    case 'phpunit': {
      // PHPUnit of the vendor directory of `cwd`; COMPOSER_VENDOR_DIR, the vendor directory setting of Composer, names another.
      const phpunit = path.join(path.resolve(cwd, process.env.COMPOSER_VENDOR_DIR || 'vendor'), 'bin/phpunit');
      // --php-extension loads a PHP extension, such as a build of the repository, into the PHP of PHPUnit.
      if (phpExtension) return { command: 'php', args: ['-d', `extension=${phpExtension}`, phpunit, '--teamcity', ...args] };
      return { command: phpunit, args: ['--teamcity', ...args] };
    }
    case 'python':
      // -v prints each test with its outcome on standard error; unittest runs one test at a time. -v goes last: before a
      // `discover` argument unittest would read `discover` as a test name.
      return { command: venv ? path.join(venv, 'bin', 'python') : toolsPath(root, 'bin', 'python3'), args: ['-m', 'unittest', ...args, '-v'] };
  }
  throw new Error(USAGE);
}

/**
 * Read go test -json events into progress lines; the output of a test is shown only when it fails. The compiler output of a
 * package that does not build arrives as `build-output` events and its end as a `build-fail` event: both are printed and the
 * error lines are added to `build` for the summary. A package that started no test case is reported as skipped.
 */
export function goEvents(progress, build = []) {
  const output = new Map();
  // The test cases that each package started; a package that started none passed nothing.
  const started = new Map();
  return line => {
    let event;
    try { event = JSON.parse(line); } catch { return progress.line(line); }
    if (event.Action === 'build-output') {
      for (const text of String(event.Output ?? '').split('\n').filter(Boolean)) {
        progress.line(text);
        if (!text.startsWith('#')) build.push(text.trim());
      }
      return undefined;
    }
    if (event.Action === 'build-fail') return progress.line(`✖ build of ${event.ImportPath} failed`);
    const id = event.Test ? `${event.Package} › ${event.Test.replaceAll('/', ' › ')}` : event.Package;
    const group = !event.Test;
    switch (event.Action) {
      case 'start': started.set(event.Package, 0); return progress.start(id, { group: true });
      case 'run':
        if (group) return undefined;
        started.set(event.Package, (started.get(event.Package) ?? 0) + 1);
        return progress.start(id);
      case 'output': {
        if (group) { if (!/^(?:ok|PASS|FAIL|\?)\s/.test(event.Output)) process.stdout.write(event.Output); return; }
        output.set(id, (output.get(id) ?? '') + event.Output);
        return;
      }
      case 'pass':
        output.delete(id);
        if (group && !started.get(event.Package)) {
          progress.skip(id);
          return progress.line(`○ ${id}: ran no test case`);
        }
        return progress.pass(id, event.Elapsed * 1000);
      case 'skip': output.delete(id); return progress.skip(id);
      case 'fail': {
        const text = (output.get(id) ?? '').split('\n').filter(entry => !/^\s*(?:=== RUN|--- FAIL|=== (?:PAUSE|CONT))/.test(entry)).join('\n');
        output.delete(id);
        return progress.fail(id, (event.Elapsed ?? 0) * 1000, text);
      }
      default: return undefined;
    }
  };
}

/**
 * Read the output of a serial runner in which a test prints `<name> ... ` when it starts and its outcome on the same line
 * when it ends. `result` matches a finished line with the name and the outcome, `pending` the name of the test that started
 * at the end of an unfinished line, `outcome` names the progress call of an outcome (`pass`, `fail` or `skip`), `idOf` turns
 * a name into a test id and `other` receives every other line. The runner is serial, so an outcome belongs to the test that
 * started last.
 */
function startResultLines(progress, { result, pending, outcome, idOf, other }) {
  let current;
  let buffer = '';
  const start = (name) => {
    if (current !== undefined) return;
    current = idOf(name);
    progress.start(current);
  };
  const line = (text) => {
    const match = result.exec(text);
    if (!match) return other(text);
    start(match[1]);
    progress[outcome(match[2])](current);
    current = undefined;
    return undefined;
  };
  return (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
    const started = pending.exec(buffer);
    if (started) start(started[1]);
  };
}

/**
 * Read serial libtest output into progress lines. A test prints `test <name> ... ` when it starts and its result (`ok`,
 * `FAILED` or `ignored`) when it ends; cargo names each test binary on standard error before running it.
 */
export function cargoEvents(progress) {
  let binary = 'cargo';
  const stdout = startResultLines(progress, {
    result: /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/,
    pending: /^test (\S+) \.\.\. $/,
    outcome: word => ({ ok: 'pass', FAILED: 'fail', ignored: 'skip' })[word],
    idOf: name => `${binary} › ${name}`,
    other: (text) => {
      if (text.trim() && !/^(?:running \d+ tests?$|test result:|failures:$|successes:$)/.test(text.trim())) progress.line(`  ${text}`);
    },
  });
  return {
    stdout,
    stderr(text) {
      const running = /^\s*(?:Running|Doc-tests)\s+(?:unittests\s+)?(\S+)/.exec(text);
      if (running) binary = running[1];
      if (text.trim()) progress.line(text.trim());
    },
  };
}

/**
 * Read the verbose output of Python unittest, which it writes to standard error, into progress lines. A test prints
 * `<method> (<module>.<class>.<method>) ... ` when it starts and its outcome when it ends: `ok` and `expected failure` pass,
 * `skipped '<reason>'` is skipped, and `FAIL`, `ERROR` and `unexpected success` fail. A test with a docstring prints its
 * description on a line of its own and the first docstring line before ` ... `; the test keeps the id of the description.
 * The failure reports at the end of the run are printed as they are.
 */
export function pythonEvents(progress) {
  const DESCRIPTION = /^\w+ \([\w.]+\)$/;
  // The description line of a test with a docstring, which names the test whose outcome follows.
  let described;
  return startResultLines(progress, {
    result: /^(.+?) \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/,
    pending: /^(.+?) \.\.\. $/,
    outcome: word => (word === 'ok' || word === 'expected failure' ? 'pass' : word.startsWith('skipped') ? 'skip' : 'fail'),
    idOf: (name) => {
      const id = described ?? name;
      described = undefined;
      return id;
    },
    other: (text) => {
      if (DESCRIPTION.test(text)) { described = text; return; }
      described = undefined;
      if (text.trim()) progress.line(`  ${text}`);
    },
  });
}

const unescapeTeamcity = value => value.replace(/\|(['|\][nr])/g, (match, character) => ({ n: '\n', r: '\r' })[character] ?? character);

/**
 * Read PHPUnit TeamCity messages into progress lines. Other lines, such as the summary with the warnings that fail the run
 * under failOnWarning, are printed as they are.
 */
export function phpunitEvents(progress) {
  const failures = new Map();
  // A test is named by its class and method; testFinished repeats only the method name.
  const ids = new Map();
  // Suites without a location (the configuration and the test suites) are printed as groups. A class or a data provider
  // method has a location on its start only, so its finish is matched by this set.
  const groups = new Set();
  const qualified = attributes => {
    const hint = /::\\?([^:]+)::(.+)$/.exec(attributes.locationHint ?? '');
    return hint ? `${hint[1].split('\\').pop()}::${hint[2]}` : attributes.name;
  };
  return line => {
    const message = /^##teamcity\[(\w+)((?: \w+='(?:[^'|]|\|.)*')*)\]$/.exec(line.trim());
    if (!message) return line.trim() ? progress.line(line) : undefined;
    const attributes = Object.fromEntries([...message[2].matchAll(/ (\w+)='((?:[^'|]|\|.)*)'/g)].map(([, key, value]) => [key, unescapeTeamcity(value)]));
    if (message[1] === 'testStarted') ids.set(attributes.name, qualified(attributes));
    const id = ids.get(attributes.name) ?? attributes.name;
    switch (message[1]) {
      case 'testSuiteStarted': {
        if (attributes.locationHint) return undefined;
        groups.add(id);
        return progress.start(id, { group: true });
      }
      case 'testSuiteFinished': return groups.delete(id) ? progress.pass(id) : undefined;
      case 'testStarted': return progress.start(id);
      // PHPUnit reports a test that ran out of its time limit and also made no assertion twice.
      case 'testFailed': failures.set(id, [failures.get(id), attributes.message ?? '', attributes.details ?? ''].filter(Boolean).join('\n')); return undefined;
      case 'testIgnored': return progress.skip(id);
      case 'testFinished': {
        const duration = Number(attributes.duration);
        if (failures.has(id)) { const text = failures.get(id); failures.delete(id); return progress.fail(id, duration, text); }
        return progress.pass(id, duration);
      }
      default: return undefined;
    }
  };
}

/** Runs the tool of `argv`; resolves the exit status of the run (0 passed, 1 failed). */
/**
 * Sends SIGTERM to the process group of a timed-out test (its pgid is the pid of the detached child). EPERM while a member is in
 * exit and ESRCH after the group ended are not errors (process-group.mjs).
 */
export function terminateGroup(pgid, kill) {
  return signalGroup(pgid, 'SIGTERM', kill);
}

export async function run(argv, { root = ROOT, write = text => process.stdout.write(text) } = {}) {
  const options = parseArguments(argv, root);
  const began = Date.now();
  const { command, args } = toolCommand(options, root);
  const label = `${options.tool} ${path.relative(root, options.cwd) || '.'}${options.args.length ? ` ${options.args.join(' ')}` : ''}`;
  write(`▶ ${label} (each test ${options.timeoutSeconds}s)\n`);
  if (options.phpExtension && !existsSync(options.phpExtension)) {
    write(`✖ ${label}: the PHP extension ${path.relative(root, options.phpExtension)} is not built; build it before the run\n`);
    return 1;
  }
  const venvRefusal = options.venv && venvProblem(options.venv, root);
  if (venvRefusal) {
    write(`✖ ${label}: ${venvRefusal}\n`);
    return 1;
  }
  const reads = ['go', 'cargo', 'phpunit', 'python'].includes(options.tool);
  const cargo = options.tool === 'cargo';
  const python = options.tool === 'python';
  // The progress reporters write their counts to this file; the runner requires that a test ran.
  const results = mkdtempSync(path.join(tmpdir(), 'kit-test-result-'));
  const resultFile = path.join(results, 'result.json');
  // A runner started from inside node --test must not join that run as its child.
  // unittest colors its verbose lines when FORCE_COLOR is set (Python 3.14); its parser reads plain lines, so the run turns
  // color off.
  const env = { ...process.env, KIT_TEST_RESULT: resultFile, ...(python ? { PYTHONUNBUFFERED: '1', NO_COLOR: '1', PYTHON_COLORS: '0' } : {}) };
  delete env.NODE_TEST_CONTEXT;
  try {
    const child = spawn(command, args, { cwd: options.cwd, env, stdio: ['ignore', reads ? 'pipe' : 'inherit', cargo || python ? 'pipe' : 'inherit'], detached: reads });
    let timedOut = false;
    const progress = reads ? createProgress({
      write,
      timeoutMs: options.timeoutSeconds * 1000,
      command: `${command} ${args.slice(0, 2).join(' ')}`,
      onTimeout: () => { timedOut = true; terminateGroup(child.pid); },
      resultFile,
    }) : undefined;
    // The error lines of the tool, which the summary names when the tool exits without a failing test.
    const errors = [];
    // The compiler errors of a Go package that does not build, which the summary names.
    const build = [];
    const noting = handle => (text) => {
      if (ERROR_LINE.test(text.trim())) errors.push(text.trim());
      handle(text);
    };
    if (cargo) {
      const events = cargoEvents(progress);
      child.stdout.setEncoding('utf8').on('data', events.stdout);
      readline.createInterface({ input: child.stderr }).on('line', noting(events.stderr));
    } else if (python) {
      // unittest writes its progress to standard error; the standard output of the tests is printed as it is.
      const events = pythonEvents(progress);
      child.stderr.setEncoding('utf8').on('data', (data) => {
        for (const text of data.split('\n')) if (ERROR_LINE.test(text.trim())) errors.push(text.trim());
        events(data);
      });
      readline.createInterface({ input: child.stdout }).on('line', text => progress.line(`  ${text}`));
    } else if (reads) {
      readline.createInterface({ input: child.stdout }).on('line', noting(options.tool === 'go' ? goEvents(progress, build) : phpunitEvents(progress)));
    }
    // A tool that cannot start, such as a command missing on PATH, fails with its command and the install fix.
    const ended = await new Promise((resolve) => {
      child.once('error', error => resolve({ error }));
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
    if (ended.error) {
      write(`✖ ${label}: cannot start ${command}: ${ended.error.message}; ${INSTALL[options.tool](options)}\n`);
      return 1;
    }
    const { status, signal } = ended;
    const code = status ?? (signal ? 1 : 0);
    let exit;
    if (progress) {
      const counts = progress.close(label, { exitCode: timedOut ? 0 : code, errors, build });
      exit = counts.ok && !timedOut ? 0 : 1;
    } else {
      // node --test and vitest print their summary from inside the tool; a tool that then ends on a signal or a nonzero
      // code fails the run, and this line names why.
      if (code !== 0) write(`✖ ${label}: the tool ended ${signal ? `on ${signal}` : `with exit code ${status}`}\n`);
      exit = code === 0 ? 0 : 1;
    }
    const counts = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
    if (counts !== null && options.results) {
      const inputs = { paths: options.inputs, digest: inputsDigest(root, options.inputs) };
      writeJson(options.results, { tool: options.tool, inputs, elapsedMs: Date.now() - began, ...counts });
      write(`▶ ${label}: recorded ${path.relative(root, options.results)}\n`);
    }
    if (counts === null) {
      write(`✖ ${label}: the progress reporter wrote no counts, so the run cannot show that a test ran; the tool must run with the reporter of scripts/kit\n`);
      return 1;
    }
    if (counts.ran === 0) {
      write(`✖ ${label}: no test ran: expected at least 1 test that passes, fails or runs out of time, actual 0 (${counts.skipped} skipped)\n`);
      return 1;
    }
    return exit;
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2)).then(status => { process.exitCode = status; }, (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
