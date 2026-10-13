// The runners of the language-parity check: the native command that runs the test of a binding, and the outcome of each
// native test that its output reports. Each runner runs the test tool of its language and reads the tool's output with the
// shared parsers of test-output.mjs, so a binding needs no line that the test prints for the check:
//   go      `go test -json` in the module of the test, with the binding symbol as the test function; a case is a direct
//           subtest `<symbol>/<case>`
//   cargo   `cargo test` in the crate of the test, with the libtest filter `<symbol>::`; a case is a test `<symbol>::<case>`
//   node    `node --test --test-reporter=tap <test>`; a case is a top-level test, and the line of the file itself is none
//   php     `php <args> vendor/bin/phpunit --teamcity --configuration <package>/phpunit.xml <test>` from the checkout root, with
//           the phpunit.xml of the Composer package of the test (phpunit.xml.dist when only that exists), or
//           `--no-configuration` when it has none; a case is a test method `test_<case>`
//   python  `python3 <args> -m unittest -v <test>`; a case is a test method `test_<case>`
import { existsSync } from 'node:fs';
import path from 'node:path';
import { goEvents, cargoEvents, phpunitEvents, pythonEvents, tapEvents } from './test-output.mjs';
import { toolsPath } from './tool-wrappers.mjs';

/** The directory of the nearest `marker` file above `file` (repository-relative), or undefined when the repository has none. */
function nearest(root, file, marker) {
  for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
    if (existsSync(path.join(root, directory, marker))) return directory;
    if (directory === '.') return undefined;
  }
}

/** A sink that keeps nothing, for the parsers that are read only for what they collect. */
const SILENT = { start() {}, pass() {}, fail() {}, skip() {}, todo() {}, line() {}, raw() {} };

/** Calls `handler` with each line of `text`. */
const eachLine = (text, handler) => text.split('\n').forEach(handler);

/** The last three lines of standard error, which explain a run that failed. */
const stderrTail = ({ stderr }) => stderr.trim().split('\n').slice(-3).filter(Boolean);

/** The part of a test name after `prefix`, or undefined when the name lies outside the binding. */
const after = (prefix, name) => (name.startsWith(prefix) ? name.slice(prefix.length) : undefined);

/** The name of a unittest or PHPUnit test method: `test_<case>` names the case `<case>`; another name is the case itself. */
const methodCase = name => (name.startsWith('test_') ? name.slice(5) : name);

// Each runner: the program that it starts unless the implementation declares `command`, the environment that it sets over the
// check's environment, and `run`, which gives the arguments and the working directory of a binding and how its output is read.
// `caseOf` names the case of a native test name, or undefined when the test is no case of the binding; `read` feeds the output
// to a sink (test-output.mjs); `detail` lists the lines that explain a failed run.
const RUNNERS = {
  go: {
    program: () => 'go',
    run(root, binding) {
      const module = nearest(root, binding.test, 'go.mod');
      if (module === undefined) return { error: `no go.mod lies above ${binding.test}` };
      const directory = path.posix.relative(module, path.posix.dirname(binding.test));
      return {
        args: test => ['test', ...test, '-json', '-count=1', '-run', `^${binding.symbol}$`, `./${directory}`],
        cwd: module,
        // A subtest nested below a case keeps its `/`, so R3 names it as a case that the suite does not declare.
        caseOf: name => after(`${binding.symbol}/`, name),
        read: ({ stdout }, sink) => eachLine(stdout, goEvents(sink)),
        // The compiler output of a package that does not build, then the standard error.
        detail: ({ stdout, stderr }) => {
          const build = [];
          eachLine(stdout, goEvents(SILENT, build));
          return [...build, ...stderr.split('\n').map(line => line.trim()).filter(Boolean)];
        },
      };
    },
  },
  cargo: {
    program: () => 'cargo',
    run(root, binding) {
      const crate = nearest(root, binding.test, 'Cargo.toml');
      if (crate === undefined) return { error: `no Cargo.toml lies above ${binding.test}` };
      const relative = path.posix.relative(crate, binding.test);
      const target = /^tests\/[^/]+\.rs$/.test(relative) ? ['--test', path.posix.basename(relative, '.rs')] : ['--lib'];
      return {
        args: test => ['test', ...test, '--manifest-path', path.posix.join(crate, 'Cargo.toml'), ...target, '--', '--test-threads=1', `${binding.symbol}::`],
        cwd: '.',
        caseOf: name => after(`${binding.symbol}::`, name),
        read: ({ stdout }, sink) => cargoEvents(sink).stdout(`${stdout}\n`),
        detail: stderrTail,
      };
    },
  },
  node: {
    program: () => process.execPath,
    run: (root, binding) => ({ args: test => [...test, '--test', '--test-reporter=tap', binding.test], cwd: '.', caseOf: name => (name === binding.test ? undefined : name), read: ({ stdout }, sink) => eachLine(stdout, tapEvents(sink)), detail: stderrTail }),
  },
  php: {
    program: () => 'php',
    run(root, binding) {
      const composer = nearest(root, binding.test, 'composer.json');
      if (composer === undefined) return { error: `no composer.json lies above ${binding.test}` };
      const phpunit = path.posix.join(composer, 'vendor/bin/phpunit');
      if (!existsSync(path.join(root, phpunit))) return { error: `${phpunit} does not exist; run composer install in ${composer}` };
      // The configuration of the package: PHPUnit reads none from the checkout root, so the run names it.
      const configuration = ['phpunit.xml', 'phpunit.xml.dist'].map(file => path.posix.join(composer, file)).find(file => existsSync(path.join(root, file)));
      const flags = configuration === undefined ? ['--no-configuration'] : ['--configuration', configuration];
      return { args: test => [...test, phpunit, '--teamcity', ...flags, binding.test], cwd: '.', caseOf: methodCase, read: ({ stdout }, sink) => eachLine(stdout, phpunitEvents(sink)), detail: stderrTail };
    },
  },
  python: {
    program: root => toolsPath(root, 'bin', 'python3'),
    // unittest writes its results to standard error; the colors are off, so the lines are plain.
    env: { NO_COLOR: '1', PYTHON_COLORS: '0' },
    run: (root, binding) => ({ args: test => [...test, '-m', 'unittest', '-v', binding.test], cwd: '.', caseOf: methodCase, read: ({ stderr }, sink) => pythonEvents(sink)(`${stderr}\n`), detail: stderrTail }),
  },
};

/**
 * The outcomes that the output of a run reports for the binding: `[name, outcome]` pairs, one for each case event in the order
 * of the output. A case that the binding does not name is left out here, and R3 judges the names that remain.
 */
export function outcomesOf(run, output) {
  const outcomes = [];
  const record = outcome => (test) => {
    const name = run.caseOf(test.name);
    if (name !== undefined) outcomes.push([name, outcome]);
  };
  // A todo is a test that the tool expects to fail, so it is no pass: the case fails.
  const sink = { ...SILENT, pass: record('pass'), fail: record('fail'), skip: record('skip'), todo: record('fail') };
  run.read(output, sink);
  return outcomes;
}

/**
 * The run of the binding `binding` of the unit `unit` (its id) in `implementation`: `{ command, args, cwd, env, caseOf, read,
 * detail }` with `cwd` relative to `root`, `env` the variables of the implementation over `base`, and `detail(output)` the
 * lines that explain a failed run; or `{ error }`. A `command` with a / is a path relative to `root`, or an absolute path.
 */
export function runOf(implementation, root, binding, unit, base) {
  const runner = RUNNERS[implementation.runner];
  const run = runner.run(root, binding, unit);
  if (run.error) return run;
  const declared = implementation.command;
  const command = declared === undefined ? runner.program(root) : declared.includes('/') ? path.resolve(root, declared) : declared;
  // A run started from inside node --test must not join that run as its child, and its node:test output is TAP only outside it.
  const { NODE_TEST_CONTEXT: _joined, ...inherited } = base;
  const env = { ...inherited, ...runner.env, ...Object.fromEntries((implementation.env ?? []).map(entry => [entry.name, entry.value])) };
  return { ...run, args: run.args(implementation.args ?? []), command, env };
}
