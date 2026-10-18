import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type Dialect, segments } from './shell.mts';

/**
 * A unit of commands that run in order: a Makefile recipe, a script or a verification command. dialect is the language
 * the commands are written in (scripts/repo/shell.mts): a recipe is make text, a step of a workflow is workflow text.
 */
export type Unit = { name: string; commands: string[]; dialect: Dialect };
/** read(path) is the text of a tracked file, or undefined when it is not tracked. */
export type Read = (path: string) => string | undefined;

// Test case reporting rule (AGENTS.md testing rule): every test case runs under its own deadline, reports its steps, results and
// elapsed time, and runs long-running work (build, install, tool run, full suite) without a deadline, with step logs.
// This module finds the tests and commands that break that rule in the text of the tracked files.

// nodeTestErrors returns one error for each JavaScript file that directly uses node:test's test functions (test, it, describe, or the default import).
// node:test tests do not emit a RUN line and a deadline per case, so a test
// is declared with caseTest from tests/testcase.mts. Hooks such as after and before may be used. files is
// {path: text}, and tests/testcase.mts, which defines caseTest, is not checked.
export function nodeTestErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === 'tests/testcase.mts' || !/\.(?:mjs|mts|js)$/.test(path)) continue;
    for (const match of text.matchAll(/^import\s+(.+?)\s+from\s+['"]node:test['"]/gm)) {
      const clause = match[1] ?? '';
      const named = /\{([^}]*)\}/.exec(clause)?.[1]?.split(',').map(item => item.trim().split(/\s+as\s+/)[0] ?? '').filter(Boolean) ?? [];
      const direct = !clause.trim().startsWith('{') || named.some(name => ['test', 'it', 'describe', 'suite'].includes(name));
      if (direct) errors.push(`${path} declares tests with node:test directly; use caseTest of tests/testcase.mts, which gives each case its deadline and RUN, PASS or FAIL line`);
    }
  }
  return errors;
}

// callerEnvironmentErrors returns one error for each line of a JavaScript test file (`.test.mjs`) that passes the environment of the process that ran it to child processes:
// `...process.env`, `env: process.env`, or a make run without `env: isolatedEnvironment(`.
// The result of such a case depends on GROUP, GITHUB_ACTIONS and ORM_CHECK_RUN_ID that CI's `make check GROUP=<group>` sets in the environment, and on the upper
// make's MAKEFLAGS and the variables the Makefile exports. A child process receives, under isolatedEnvironment in tests/environment.mts,
// only the variables that the case gives. files is {path: text}.
export function callerEnvironmentErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/\.test\.m[jt]s$/.test(path)) continue;
    text.split('\n').forEach((line: string, index: number) => {
      const at = `${path}:${index + 1}`;
      if (/\.\.\.process\.env\b|\benv:\s*process\.env\b(?!\.)/.test(line))
        errors.push(`${at} gives a child process the environment of its caller; give it isolatedEnvironment of tests/environment.mts with the variables of the case`);
      else if (/\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*['"]make['"]/.test(line) && !/\benv:\s*isolatedEnvironment\(/.test(line))
        errors.push(`${at} runs make with the environment of its caller, whose GROUP, GITHUB_ACTIONS and MAKEFLAGS reach the recipe; pass env: isolatedEnvironment(...) of tests/environment.mts with the variables of the case`);
    });
  }
  return errors;
}

// The body runs from the first `{` after the text's index to the matching `}`. Parentheses inside strings are not counted, so it is used
// only to find function boundaries.
function body(text: string, index: number): string {
  const start = text.indexOf('{', index);
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === '{') depth++;
    else if (text[at] === '}' && --depth === 0) return text.slice(start, at + 1);
  }
  return text.slice(start);
}

// rustTestCaseErrors returns one error each time a Rust #[test] or #[tokio::test] function does not start a polyspec_orm_testcase case (the case! macro or
// start). files is {path: text}.
export function rustTestCaseErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.rs')) continue;
    const pattern = /#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
    for (const match of text.matchAll(pattern))
      if (!/\bcase!\(|\btestcase::(?:case!|start)\(/.test(body(text, (match.index ?? 0) + match[0].length)))
        errors.push(`${path}: ${match[1]} does not start its case with polyspec_orm_testcase, so it runs without a deadline or RUN line`);
  }
  return errors;
}

// testEntries returns, from the command text, the files (.php, .mjs) under packages/<runtime>/tests/ that php or node runs,
// and all of them when there are several files, as in `node --test a.mjs b.mjs`.
export function testEntries(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/(?:^|[\s;&|(])(?:php|node)((?:\s+-[-\w=]+)*)((?:\s+[\w./-]+\.(?:php|m[jt]s))+)/g))
    for (const path of (match[2] ?? '').trim().split(/\s+/))
      if (/^packages\/(?:go|ts|php|php-ext|python|rust)\/tests\//.test(path)) out.push(path);
  return out;
}

// dependencies returns, as repository-relative paths, the files that a PHP file requires from __DIR__ or dirname(__DIR__, n), and the files that a JavaScript file imports by relative
// path.
function dependencies(path: string, text: string): string[] {
  const directory = path.split('/').slice(0, -1);
  // posix.join resolves the . and .. segments of a relative path against its directory.
  const resolve = (base: string[], relative: string) => posix.join(...base, relative);
  if (path.endsWith('.php'))
    return [...text.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__|dirname\(__DIR__(?:,\s*(\d+))?\))\s*\.\s*'([^']+)'/g)]
      .map(match => resolve(directory.slice(0, directory.length - (match[0].includes('dirname') ? Number(match[1] ?? 1) : 0)), match[2] ?? ''));
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map(match => resolve(directory, match[1] ?? ''));
}

// reportingScriptErrors returns one error each time a test file that a command (commands: {source, command}) runs does not report a case.
// A TypeScript test must write the shared case report (tests/testcase.mts), directly or through an imported file.
// PHP tests are run, reported and given a deadline by PHPUnit (vendor-php/bin/phpunit of the development root, and that package's phpunit.xml.dist).
// So it is an error if php runs a file in packages/<runtime>/tests/ directly.
// read(path) is the text of a tracked file, or undefined if there is none.
export function reportingScriptErrors(commands: { source: string; command: string }[], read: Read): string[] {
  const reports = (path: string, seen = new Set<string>()): boolean => {
    if (path === 'tests/testcase.mts') return true;
    if (seen.has(path)) return false;
    seen.add(path);
    const text = read(path);
    return text !== undefined && dependencies(path, text).some(next => reports(next, seen));
  };
  const errors: string[] = [];
  const checked = new Set<string>();
  for (const { source, command } of commands) {
    for (const path of testEntries(command)) {
      if (checked.has(path)) continue;
      checked.add(path);
      if (read(path) === undefined) errors.push(`${source} runs ${path}, which is not a tracked file`);
      else if (path.endsWith('.php')) errors.push(`${source} runs ${path} with php, not with PHPUnit (vendor-php/bin/phpunit with the phpunit.xml.dist of its package), so it runs without a deadline or a case report`);
      else if (!reports(path)) errors.push(`${source} runs ${path}, which reports no case through tests/testcase.mts, so it runs without a deadline or RUN line`);
    }
  }
  return errors;
}

// Build and lint tools do not report their own cases. Because these tools are long-running work, they run
// under tests/run-long.mts (Makefile's RUN_LONG, TSC_BUILD) without a deadline, with step logs (RUN, STEP, exit code, PASS or FAIL).
// `cargo test --no-run` is checked by unbuiltCargoTestErrors.
const tools: [string, RegExp][] = [
  ['tsc', /(?:^|[\s/])tsc(?=\s|$)/],
  ['a TypeScript build', /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+(?:typescript:build|typescript:check|build)(?=\s|$)/],
  ['go generate', /\bgo\s+generate\b/],
  ['go vet', /\bgo\s+vet\b/],
  ['go build', /\bgo\s+build\b/],
  ['cargo build', /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy)\b/],
];
const noRun = /\bcargo\s+(?:\+\S+\s+)?test\b(?=.*\s--no-run\b)/;
// longRunner is the runner that runs long-running work without a deadline, with step logs.
const longRunner = /(?:\brun-long\.mts|\$\(RUN_LONG\)|\$\(TSC_BUILD\))/;
// deadlineForms is the form that puts a deadline on the whole command: tests/run-case.mjs (Makefile's
// RUN_CASE), which takes a deadline and ends the command, its deadline variable, timeout(1), and a go test run whose -timeout is non-zero, or the default of 10 minutes when it is absent, for the test
// binary as a whole (a `-c` build is not run).
const deadlineForms = [
  /\brun-case\.mjs\b/,
  /\$\(RUN_CASE\)/,
  /\$\((?:BUILD|TOOL)_DEADLINE\)/,
  /(?:^|\s)g?timeout\s+(?:-\S+\s+)*[0-9][0-9.]*[smhd]?(?=\s)/,
];
const goTestRun = /(?:^|\s)(?:go\s+test|node\s+tests\/go-test\.mts)(?=\s|$)(.*)$/;

// deadline is the form of the deadline that a segment puts on the command (the matched text), and undefined if there is none. If before is given, only the form
// before the position is checked.
export function deadline(segment: string, before = segment.length): string | undefined {
  for (const form of deadlineForms) {
    const match = form.exec(segment);
    if (match && match.index < before) return match[0].trim();
  }
  const go = goTestRun.exec(segment);
  if (go && go.index < before && !/\s-c(?:\s|$)/.test(go[1] ?? '')) {
    const timeout = /\s-timeout(?:=|\s+)(\S+)/.exec(go[1] ?? '');
    if (!timeout) return 'go test without -timeout 0 (the default 10m)';
    if (timeout[1] !== '0') return `go test -timeout ${timeout[1]}`;
  }
  return undefined;
}

// cargoArguments returns the arguments of `cargo test` in the segment before `--`, without `--no-run` and the toolchain (`+x`).
// It checks whether the build and the run use the same test binary.
function cargoArguments(segment: string): string | undefined {
  const match = /\bcargo\s+(?:\+\S+\s+)?test\b(.*)$/.exec(segment);
  if (!match) return undefined;
  const before = (match[1] ?? '').split(/\s--(?:\s|$)/)[0] ?? '';
  return before.trim().split(/\s+/).filter(token => token && token !== '--no-run').join(' ');
}

// longOperationError returns one error if a segment that runs long-running work (what) breaks the rule, and undefined if it keeps it:
// long-running work runs under longRunner with step logs and has no deadline. at is
// the position where the work starts inside the segment.
function longOperationError(name: string, what: string, segment: string, at: number): string | undefined {
  const form = deadline(segment, at);
  if (form) return `${name} runs ${what} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  const runner = longRunner.exec(segment);
  if (!runner || runner.index > at) return `${name} runs ${what} outside tests/run-long.mts, so it has no RUN line or step log: ${segment}`;
  return undefined;
}

// unwrappedToolErrors returns one error for each segment that runs a tool of tools outside RUN_LONG,
// or under a deadline, from units (the list of commands with their names, in order).
export function unwrappedToolErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units) {
    for (const command of commands) {
      for (const segment of segments(command, dialect)) {
        const found = tools.find(([, pattern]) => pattern.test(segment));
        if (!found) continue;
        const error = longOperationError(name, found[0], segment, found[1].exec(segment)?.index ?? 0);
        if (error) errors.push(error);
      }
    }
  }
  return errors;
}

// unbuiltCargoTestErrors returns one error each time a `cargo test --no-run` build in units runs outside RUN_LONG or under a deadline,
// and each time a `cargo test` run (without --no-run) is outside tests/cargo-test.mts (Makefile's CARGO_TEST).
// cargo test runs the test binary in the shared Rust target directory (which this checkout's concurrent runs share),
// so if another run builds again between the build and the run, it runs that code. tests/cargo-test.mts builds under a lease
// and runs a copied binary of one run; that build is long-running work without a deadline, with step logs.
export function unbuiltCargoTestErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const cargo = cargoArguments(segment);
        if (cargo === undefined) continue;
        if (/\s--no-run\b/.test(segment)) {
          const error = longOperationError(name, `the build cargo test --no-run ${cargo}`, segment, noRun.exec(segment)?.index ?? 0);
          if (error) errors.push(error);
        } else if (!/\bcargo-test\.mts\b|\$\(CARGO_TEST\)/.test(segment))
          errors.push(`${name} runs cargo test ${cargo} outside tests/cargo-test.mts, so it runs the test binaries of the shared Rust target directory`);
      }
  return errors;
}

// longDeadlineErrors returns one error for each segment in units that puts a deadline on a command (deadline). The commands of check
// are long-running work (build, install, tool run, the full suite); deadlines go only inside test cases.
export function longDeadlineErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const form = deadline(segment);
        if (form) errors.push(`${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`);
      }
  return errors;
}

// recipeLines returns the Makefile's lines (lines, recipe lines starting with a tab, and the others) as make reads them: a line
// ending in `\` continues with the next line. A recipe line is one command as continued (make removes one tab at the start of a continued line),
// and other lines, as make does, change the continuation and the whitespace around it into a single space. A recipe line without its leading tab is { recipe: true, text },
// and other lines are { recipe: false, text }.
export function recipeLines(makefile: string): { recipe: boolean; text: string }[] {
  const out: { recipe: boolean; text: string }[] = [];
  const lines = makefile.split('\n');
  // An odd number of backslashes at the end continues the line; an even number is escaped backslashes.
  const continues = (text: string) => /(?:^|[^\\])(?:\\\\)*\\$/.test(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!line.startsWith('\t')) {
      let text = line;
      while (continues(text) && index + 1 < lines.length) text = `${text.slice(0, -1).trimEnd()} ${(lines[++index] ?? '').trimStart()}`;
      out.push({ recipe: false, text });
      continue;
    }
    const command = [line.slice(1)];
    while (continues(command.at(-1) ?? '') && index + 1 < lines.length) command.push((lines[++index] ?? '').replace(/^\t/, ''));
    out.push({ recipe: true, text: command.join('\n') });
  }
  return out;
}

/** A rule of a Makefile: its target, its prerequisites (normal and order-only) and its recipe commands. */
export type MakeTarget = { target: string; prerequisites: string[]; commands: string[] };

// makeEntries returns the Makefile, as make reads it (recipeLines), as { targets, prerequisites, commands } for each rule.
// A rule line is `targets: prerequisites` or `targets:: prerequisites`; what follows `;` is the first command of its recipe, and the order-only prerequisite targets after `|`
// are also prerequisite targets. Variable definitions (`=`, `:=`, `::=`, `?=`, `+=`) and target-specific variables
// (`target: NAME = value`), and directives (such as ifeq, include, export), are not rules: the recipe lines after them go into an entry with no name
// (targets []). Blank lines and comments do not end a recipe.
function makeEntries(makefile: string): { targets: string[]; prerequisites: string[]; commands: string[] }[] {
  const entries: { targets: string[]; prerequisites: string[]; commands: string[] }[] = [];
  const directive = /^(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|define|endef|export|unexport|override|undefine|vpath|private)\b/;
  for (const { recipe, text } of recipeLines(makefile)) {
    if (recipe) {
      entries.at(-1)?.commands.push(text);
      continue;
    }
    const line = text.replace(/(?:^|\s)#.*$/, '');
    if (line.trim() === '') continue;
    const rule = directive.test(line.trimStart()) ? null : /^([^:=#;\t][^:=#;]*?)\s*::?(?!=)(.*)$/.exec(line);
    const [head, rest] = rule ? [(rule[2] ?? '').split(';')[0] ?? '', (rule[2] ?? '').includes(';') ? (rule[2] ?? '').slice((rule[2] ?? '').indexOf(';') + 1).trim() : undefined] : ['', undefined];
    if (!rule || head.includes('=')) {
      entries.push({ targets: [], prerequisites: [], commands: [] });
      continue;
    }
    entries.push({
      targets: (rule[1] ?? '').trim().split(/\s+/),
      prerequisites: head.trim().split(/\s+/).filter(word => word !== '' && word !== '|'),
      commands: rest ? [rest] : [],
    });
  }
  return entries;
}

// makeTargets returns one target per rule of the Makefile, with its prerequisite targets and recipe commands (makeEntries). The target
// names are exactly as make uses them: sub-targets containing `/` (testcase-check/go), pattern rules (`%`), and special targets (.PHONY).
// Reading of the Makefile in this module, in scripts/repo/ci.mts and in scripts/features/owners.mts all use this.
export function makeTargets(makefile: string): MakeTarget[] {
  return makeEntries(makefile).flatMap(({ targets, prerequisites, commands }) => targets.map(target => ({ target, prerequisites, commands })));
}

// makeRecipes returns the recipe commands (makeTargets) of each Makefile target as one unit. A recipe line after a line that is not a rule
// is a unit named `Makefile`. A target with no recipe is not a unit.
export function makeRecipes(makefile: string): Unit[] {
  return makeEntries(makefile)
    .flatMap(({ targets, commands }) => (targets.length ? targets.map(target => `Makefile ${target}`) : ['Makefile']).map(name => ({ name, commands, dialect: 'make' as const })))
    .filter(unit => unit.commands.length);
}

// reachedScripts returns the shell scripts in scripts/ that a command (commands: {command, dialect}) runs outside tests/run-long.mts,
// and the command scripts (scriptCommands), and the scripts that those scripts in turn run that way. One script is a unit whose whole text is one command.
// A script under run-long is one long-running work as a whole
// with step logs. With throughLong, a script under run-long is also included: the commands in it do not get a deadline either.
// read(path) is the text of a tracked file, or undefined if there is none.
export function reachedScripts(commands: { command: string; dialect: Dialect }[], read: Read, { throughLong = false }: { throughLong?: boolean } = {}): Unit[] {
  const reached = new Map<string, string>();
  const visit = (command: string, dialect: Dialect) => {
    for (const segment of segments(command, dialect)) {
      if (!throughLong && longRunner.test(segment)) continue;
      for (const match of segment.matchAll(/(?:^|[\s"'/])(scripts\/[\w/.-]+\.(?:sh|mts))\b/g)) {
        const path = match[1] ?? '';
        if (reached.has(path)) continue;
        const text = read(path);
        if (text === undefined) continue;
        reached.set(path, text);
        visit(text, 'sh');
      }
    }
  };
  commands.forEach(({ command, dialect }) => visit(command, dialect));
  return [...reached].map(([path, text]) => ({ name: path, commands: [text], dialect: 'sh' }));
}

// generateRuns returns the directory in which a command runs `go generate`. It also reads inside `sh -c '...'`, and sets the directory with
// `cd <dir>` before it and run-long's `--cwd <dir>`. Generation rewrites tracked files and compares them with `git diff`,
// so generation in the same directory runs only once in make check.
export function generateRuns(command: string, dialect: Dialect): string[] {
  const out: string[] = [];
  const visit = (text: string, language: Dialect, cwd: string) => {
    let directory = cwd;
    for (const segment of segments(text, language)) {
      const nested = /\bsh\s+-c\s+'([^']*)'/.exec(segment);
      const runCase = /--cwd\s+(\S+)/.exec(segment);
      if (nested) { visit(nested[1] ?? '', language, runCase?.[1] ?? directory); continue; }
      const cd = /^cd\s+(\S+)$/.exec(segment);
      if (cd) { directory = cd[1] ?? directory; continue; }
      const generate = /\bgo\s+generate\s+(\S+)/.exec(segment);
      if (generate) out.push(`${(runCase?.[1] ?? directory).replace(/\/$/, '')}/${generate[1] ?? ''}`.replace(/\/\.\/?$/, '').replace(/^\.\//, ''));
    }
  };
  visit(command, dialect, '.');
  return out;
}

// repeatedGenerateErrors returns one error each time a unit of make check (the recipe of CHECK_TARGETS and the verification command of feature-check) runs
// `go generate` in the same directory two or more times.
export function repeatedGenerateErrors(units: Unit[]): string[] {
  const seen = new Map<string, string[]>();
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const directory of generateRuns(command, dialect)) {
        seen.set(directory, [...(seen.get(directory) ?? []), name]);
      }
  return [...seen].filter(([, names]) => names.length > 1)
    .map(([directory, names]) => `go generate of ${directory} runs ${names.length} times in make check: ${names.join(', ')}`);
}

// rawGoTestErrors returns one error for each segment in units that runs `go test` without tests/go-test.mts or RUN_LONG, or under a deadline.
// go test compiles before it runs the tests, and that compile is long-running work not reported as a case.
// tests/go-test.mts first runs the build without a deadline, with step logs,
// and RUN_LONG runs the whole command as one long-running work (as when an instrumented build runs alongside the fuzzing).
// The deadline of the whole test binary (`-timeout`) is checked by longDeadlineErrors. The Makefile's variables are resolved beforehand.
export function rawGoTestErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const match = /(?:^|\s)go\s+test\b/.exec(segment);
        if (!match || /\btests\/go-test\.mts\b/.test(segment)) continue;
        const form = deadlineForms.map(pattern => pattern.exec(segment)).find(found => found && found.index < match.index);
        if (form) errors.push(`${name} runs go test under a deadline (${form[0].trim()}); a long operation gets step logs and no deadline: ${segment}`);
        else {
          const runner = longRunner.exec(segment);
          if (!runner || runner.index > match.index)
            errors.push(`${name} runs go test outside tests/go-test.mts, so its compile has no RUN line or step log: ${segment}`);
        }
      }
  return errors;
}

// sharedTargetErrors returns one error each time the Makefile uses the shared Rust target directory (CARGO_TARGET_DIR, which this checkout's concurrent runs share)
// as if it were one run's own. Running a program in that directory, or writing a file there,
// makes a run use what another checkout rebuilt or overwrote in between. A run uses its own copy in RUN_DIR and writes its own files
// (CARGO_COPY), and cargo build happens under the lease of the target directory (CARGO_LEASED). Comments are not checked.
export function sharedTargetErrors(makefile: string): string[] {
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    // The lease directory (CARGO_LEASES) is placed inside the target directory, so every checkout that shares that directory sees the same
    // lease.
    if (/^\s*#/.test(line) || /^CARGO_LEASES = \$\(CARGO_TARGET_DIR\)\/\.leases$/.test(line)) continue;
    if (line.includes('$(CARGO_TARGET_DIR)/'))
      errors.push(`Makefile:${index + 1} uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): ${line.trim()}`);
  }
  for (const { name, commands, dialect } of makeRecipes(makefile))
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const cargo = /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|test\b(?=.*\s--no-run\b))/.exec(segment);
        if (!cargo) continue;
        const leased = /\$\((?:CARGO_LEASED|CARGO_COPY)\)/.exec(segment);
        if (!leased || leased.index > cargo.index)
          errors.push(`${name} builds into the shared Rust target directory without its lease; run the build under $(CARGO_LEASED) or $(CARGO_COPY): ${segment}`);
      }
  return errors;
}

// runtimePathErrors returns one error for each line in the Makefile that writes a fixed file of .runtime shared by several runs (or the file beside TEST_ENV)
// as one file. A run's own file goes in RUN_DIR. What is shared is only the server
// environment (TEST_ENV), the built tools (.runtime/bin), the root of the run directories (.runtime/run), and the lease directories (*.leases).
export function runtimePathErrors(makefile: string): string[] {
  const allowed = [/^TEST_ENV = \.runtime\/servers\/env$/, /\.runtime\/bin\//, /\.runtime\/run\)/, /\.leases\)?$/];
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    if (!/\.runtime\/|\$\(dir \$\(abspath \$\(TEST_ENV\)\)\)/.test(line)) continue;
    if (allowed.some(pattern => pattern.test(line.trim()))) continue;
    errors.push(`Makefile:${index + 1} names a fixed file that runs would share; put the file of one run into $(RUN_DIR): ${line.trim()}`);
  }
  return errors;
}

// fixedPortErrors returns one error for each line that sets a fixed TCP port (files is the {path: text} of the Makefile and the shell scripts):
// an assignment such as `<NAME>PORT = <number>`, and `test-servers.mts start` given a port as an argument. Servers of two checkouts
// contend for the same fixed port, so make test-servers picks an empty port (scripts/free-ports.mts) and records it in the environment file. Comment lines are not checked.
export function fixedPortErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line: string, index: number) => {
      if (/^\s*#/.test(line)) return;
      if (/^\s*(?:export\s+)?\w*PORT\s*[:?]?=\s*\d+\b/.test(line) || /test-servers\.mts start\s+(?:\$|\d)/.test(line))
        errors.push(`${path}:${index + 1} fixes a TCP port that the servers of another checkout can hold; let make test-servers choose free ports (scripts/free-ports.mts) and read them from its environment file: ${line.trim()}`);
    });
  }
  return errors;
}

// unpublishedOutputErrors returns one error for each Makefile line that writes build output directly to its place: `go build -o` or
// a `go test -c -o` whose output is not @OUT@, a line that redirects standard output to a file (`> file`), and a line that runs tsc directly.
// Such output leaves a half-written file when the build is cut off, and other runs or later steps read a file still being written. Output is
// written to a temporary file and renamed by $(PUBLISH) (scripts/publish-output.mts), and the TypeScript client is built with scripts/typescript/build.mts.
// Comment lines, stderr redirects (>&2) and /dev/null are not checked.
export function unpublishedOutputErrors(makefile: string): string[] {
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    const text = line.replace(/\d?>&\d|>\s*\/dev\/null/g, '');
    const direct = /\bgo (?:build|test -c)\b[^#]*\s-o\s+(?!@OUT@)\S/.test(text) ? 'writes a Go build output in place'
      : /(?<![-=<>])>>?\s*[^\s&>]/.test(text) && !/^\s*@?echo /.test(text.replace(/^\t/, '')) ? 'redirects a command into a file in place'
      : /typescript\/bin\/tsc\b(?![^#]*--noEmit)/.test(text) ? 'runs tsc into dist in place' : '';
    if (direct) errors.push(`Makefile:${index + 1} ${direct}, so a stopped build leaves half a file that another run reads; write it through $(PUBLISH) <output> <command> (@OUT@ names the temporary file) or scripts/typescript/build.mts: ${line.trim()}`);
  }
  return errors;
}

// typescriptHolderErrors returns one error for each make target that builds the TypeScript client (TSC_BUILD, npm's typescript:build, typescript:test,
// typescript:check, and scripts/client-db-test.mts that does it) that does not get the holding ($(HOLD_TYPESCRIPT)) of that build output.
// A target gets the holding on the first line of its recipe, or gets it
// through a prerequisite target that gets it (ts-check/hold of ts-check/types): make runs prerequisite targets first.
export function typescriptHolderErrors(makefile: string): string[] {
  const builds = /\$\(TSC_BUILD\)|typescript:(?:build|test|check)\b|client-db-test\.sh|tests\/conformance\/check run\b/;
  const targets = makeTargets(makefile);
  const rules = new Map(targets.map(rule => [rule.target, rule]));
  const holds = (target: string, seen = new Set<string>()): boolean => {
    const rule = rules.get(target);
    if (!rule || seen.has(target)) return false;
    seen.add(target);
    return (rule.commands[0] ?? '').trim() === '$(HOLD_TYPESCRIPT)' || rule.prerequisites.some(prerequisite => holds(prerequisite, seen));
  };
  return targets
    .filter(rule => rule.commands.some(command => builds.test(command)) && !holds(rule.target))
    .map(rule => `Makefile ${rule.target} builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)`);
}

// unleasedCargoErrors returns one error for each segment in which a command outside the Makefile (verification command, script, package.json script) builds in the shared Rust target
// directory (CARGO_TARGET_DIR) without a lease, or runs a program from it.
// The build runs under `"$LEASE" run "$CARGO_LEASES" exclusive --wait --` (tests/cargo-test.mts does this itself),
// and the program to run is copied, under that lease, into one run directory (scripts/cargo-build-copy.mts).
export function unleasedCargoErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        if (/\bcargo-test\.mts\b/.test(segment)) continue;
        const cargo = /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|test\b(?=.*\s--no-run\b))/.exec(segment);
        const leased = /"?\$\{?LEASE(?::\?[^}]*)?\}?"?\s+run\b/.exec(segment);
        if (cargo && (!leased || leased.index > cargo.index))
          errors.push(`${name} builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`);
        if (/\$\{CARGO_TARGET_DIR[^}]*\}\/|\$CARGO_TARGET_DIR\//.test(segment))
          errors.push(`${name} runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.mts): ${segment}`);
      }
  return errors;
}

// usesTypescriptOutput is whether a JavaScript file at the path uses the TypeScript client's build output (packages/ts/dist):
// a file that imports `dist/` directly, or runs through a relative import or a `packages/ts/...mjs` path, uses it.
export function usesTypescriptOutput(path: string, read: Read, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  const text = read(path);
  if (text === undefined) return false;
  // It looks only at import statements (static, dynamic, re-export). An import example inside a string is not a use.
  // Static imports and re-exports can span several lines (`import {\n  a,\n} from '../dist/index.js'`).
  // Only a list of names inside `{ ... }` may cross lines: it holds only names, `as`, commas and spaces.
  if (/^\s*(?:(?:import|export)\s+(?:type\s+)?(?:[\w$*]+(?:\s+as\s+[\w$]+)?\s*,?\s*)?(?:\{[\w$\s,]*\}\s*)?from\s*|(?:[^'"\n]*\bawait\s+)?import\(\s*)['"](?:(?:\.\.\/)+|[\w./-]*packages\/ts\/)dist\//m.test(text)) return true;
  return [...dependencies(path, text), ...nodeRuns(text)].some((next: string) => usesTypescriptOutput(next, read, seen));
}

// nodeRuns is the file in packages/ts that JavaScript text runs with node. Runs take two forms: a program and an argument array
// (`'node', ['<file>', ...]` or `process.execPath, ['<file>', ...]`), and the shell string of an exec or spawn call
// (`execSync('node [option...] <file>')`). A place where a path is only written as a string (expected output, stub, regular expression, comment) is not a run.
export function nodeRuns(text: string): string[] {
  const file = '(packages\\/ts\\/[\\w./-]+\\.mjs)';
  const forms = [
    new RegExp(`(?:['"]node['"]|process\\.execPath)\\s*,\\s*\\[\\s*['"]${file}['"]`, 'g'),
    new RegExp(`\\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\\(\\s*['"\`]node\\s+(?:--\\S+\\s+)*${file}`, 'g'),
  ];
  return forms.flatMap(form => [...text.matchAll(form)].map(match => match[1] ?? ''));
}

// typescriptReaderErrors returns one error for each make target that runs with node a file writing the TypeScript client's build output and, on its first line,
// does not get the holding of that output ($(READ_TYPESCRIPT) to read, $(HOLD_TYPESCRIPT) when building).
export function typescriptReaderErrors(makefile: string, read: Read): string[] {
  const errors: string[] = [];
  for (const unit of makeRecipes(makefile)) {
    if (unit.name === 'Makefile' || /^\$\((?:READ|HOLD)_TYPESCRIPT\)$/.test((unit.commands[0] ?? '').trim())) continue;
    const files = unit.commands.flatMap(command => [...command.matchAll(/\bnode\s+(?:--test\s+)?((?:[\w./-]+\.mjs\s*)+)/g)]
      .flatMap(match => (match[1] ?? '').trim().split(/\s+/)));
    const reader = files.find(file => usesTypescriptOutput(file, read));
    if (reader) errors.push(`${unit.name} runs ${reader}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`);
  }
  return errors;
}

// goRunErrors returns one error for each segment in units that runs `go run`. go run compiles without
// output before it runs the program, so that build is long-running work without step logs. tests/go-run.mts runs the build
// as long-running work with step logs and no deadline, then runs the program.
export function goRunErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect))
        if (/(?:^|[\s=;&|(])go\s+run\b/.test(segment))
          errors.push(`${name} runs go run, whose build has no step log; run it through tests/go-run.mts: ${segment}`);
  return errors;
}

/**
 * scriptCommands is the command text of every script of scripts/, by path: the lines of a shell script, and the COMMANDS
 * that a TypeScript command script exports (scripts/check/commands.mts), one per line. A TypeScript file of scripts/
 * that exports no COMMANDS runs no command of a check and is left out.
 */
export async function scriptCommands(root: string, tracked: readonly string[]): Promise<Map<string, string>> {
  const scripts = new Map<string, string>();
  for (const path of tracked) {
    if (!path.startsWith('scripts/')) continue;
    if (path.endsWith('.sh')) scripts.set(path, readFileSync(join(root, path), 'utf8'));
    else if (path.endsWith('.mts') && /^export const COMMANDS\b/m.test(readFileSync(join(root, path), 'utf8'))) {
      const module: unknown = await import(join(root, path));
      const commands = typeof module === 'object' && module !== null && 'COMMANDS' in module ? module.COMMANDS : undefined;
      if (!Array.isArray(commands) || !commands.every((command): command is string => typeof command === 'string'))
        throw new Error(`${path} exports COMMANDS that are not a list of command lines`);
      scripts.set(path, commands.join('\n'));
    }
  }
  return scripts;
}
