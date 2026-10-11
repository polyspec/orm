// The runners of the language-parity check: the native command that runs the test of a binding, and the cases that its output
// reports. go runs `go test -json` in the module of the test with the binding symbol as the test function, and a case is a
// direct subtest `<symbol>/<case>`. cargo runs the exact test path of the symbol in the crate of the test (`--test <name>`
// for tests/<name>.rs, else `--lib`), and node, php and python (var/tools/bin/python3) run the test file; these four read the
// harness lines `PASS <unit>/<case>` and `FAIL <unit>/<case>` that the shared test harness of each language prints (cargo on
// both output streams, after the `test <name> ... ` that libtest prints without a line break).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { toolsPath } from './tool-wrappers.mjs';

/** The directory of the nearest `marker` file above `file` (repository-relative), or undefined when the repository has none. */
function nearest(root, file, marker) {
  for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
    if (existsSync(path.join(root, directory, marker))) return directory;
    if (directory === '.') return undefined;
  }
}

// libtest prints `test <name> ... ` without a line break before it runs a test, so with --nocapture the first line that the
// test prints continues it.
const LIBTEST_PREFIX = /^test \S+ \.\.\. /;

/**
 * The outcome of each case that the harness lines of `output` report for `unit`, in the order of the output; a FAIL wins.
 * `prefix` is a regular expression that a line may start with before its harness line.
 */
function harnessCases(output, unit, prefix) {
  const cases = new Map();
  for (const line of output.split('\n')) {
    const match = /^(PASS|FAIL) (\S+)/.exec(prefix ? line.trim().replace(prefix, '') : line.trim());
    if (!match || !match[2].startsWith(`${unit}/`)) continue;
    const name = match[2].slice(unit.length + 1);
    if (cases.get(name) !== 'fail') cases.set(name, match[1] === 'PASS' ? 'pass' : 'fail');
  }
  return cases;
}

/** The outcome of each direct subtest of `symbol` in the events of `go test -json`. */
function goCases(output, symbol) {
  const cases = new Map();
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const name = typeof event.Test === 'string' && event.Test.startsWith(`${symbol}/`) ? event.Test.slice(symbol.length + 1) : '';
    if (name && !name.includes('/') && ['pass', 'fail', 'skip'].includes(event.Action)) cases.set(name, event.Action);
  }
  return cases;
}

/** The compiler output of a Go package that did not build: the lines of its `build-output` events and of standard error. */
function goBuildOutput({ stdout, stderr }) {
  const lines = stdout.split('\n').flatMap((line) => {
    let event;
    try { event = JSON.parse(line); } catch { return []; }
    return event.Action === 'build-output' ? String(event.Output ?? '').split('\n') : [];
  });
  return [...lines, ...stderr.split('\n')].map(line => line.trim()).filter(Boolean);
}

// Each runner: the program that it starts unless the implementation declares `command`, and the run of a binding, whose
// `options` are the `args` of the implementation.
const RUNNERS = {
  go: {
    program: () => 'go',
    run(root, binding, unit, options) {
      const module = nearest(root, binding.test, 'go.mod');
      if (module === undefined) return { error: `no go.mod lies above ${binding.test}` };
      const directory = path.posix.relative(module, path.posix.dirname(binding.test));
      return { args: ['test', ...options, '-json', '-count=1', '-run', `^${binding.symbol}$`, `./${directory}`], cwd: module, cases: ({ stdout }) => goCases(stdout, binding.symbol), detail: goBuildOutput };
    },
  },
  cargo: {
    program: () => 'cargo',
    run(root, binding, unit, options) {
      const crate = nearest(root, binding.test, 'Cargo.toml');
      if (crate === undefined) return { error: `no Cargo.toml lies above ${binding.test}` };
      const relative = path.posix.relative(crate, binding.test);
      const target = /^tests\/[^/]+\.rs$/.test(relative) ? ['--test', path.posix.basename(relative, '.rs')] : ['--lib'];
      // A Rust harness line reaches standard output (println!) or standard error (eprintln!); both are read.
      return { args: ['test', ...options, '--manifest-path', path.posix.join(crate, 'Cargo.toml'), ...target, '--', '--exact', binding.symbol, '--nocapture', '--test-threads=1'], cwd: '.', cases: ({ stdout, stderr }) => harnessCases(`${stdout}\n${stderr}`, unit, LIBTEST_PREFIX) };
    },
  },
  node: { program: () => process.execPath },
  php: { program: () => 'php' },
  python: { program: root => toolsPath(root, 'bin', 'python3') },
};

/** The run of a file runner (node, php, python): the program with the options and the test file, in the root of the checkout. */
const fileRun = (root, binding, unit, options) => ({ args: [...options, binding.test], cwd: '.', cases: ({ stdout }) => harnessCases(stdout, unit) });

/**
 * The run of the binding `binding` of the unit `unit` (its id) in `implementation`: `{ command, args, cwd, env, cases }` with
 * `cwd` relative to `root`, `env` the variables of the implementation over `base`, `cases({ stdout, stderr })` the outcome of
 * each case that the output reports, and `detail({ stdout, stderr })` the lines that explain a failed run (the last three lines
 * of standard error; for go the whole compiler output); or `{ error }`. A `command` with a / is a path relative to `root`, or
 * an absolute path.
 */
export function runOf(implementation, root, binding, unit, base) {
  const runner = RUNNERS[implementation.runner];
  const run = (runner.run ?? fileRun)(root, binding, unit, implementation.args ?? []);
  if (run.error) return run;
  const declared = implementation.command;
  const command = declared === undefined ? runner.program(root) : declared.includes('/') ? path.resolve(root, declared) : declared;
  const env = { ...base, ...Object.fromEntries((implementation.env ?? []).map(entry => [entry.name, entry.value])) };
  return { detail: ({ stderr }) => stderr.trim().split('\n').slice(-3).filter(Boolean), ...run, command, env };
}
