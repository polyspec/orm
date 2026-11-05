import { spawn } from 'node:child_process';
import { endGroup } from '../check/step.mts';
import { testDirectoryOf } from './packages.mts';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROCESS, runCase, runLong, stepLines } from '../../tests/testcase.mts';
import { errorCode } from '../../tests/errors.mts';
import { GO_TEST_TAGS } from '../../tests/go-test.mts';
import { readFeatures } from './manifest.mts';
import { implementationLanguages, featureLanguages } from './languages.mts';
import { parseRecipeCases, type ParityConfig } from '../json/formats.mts';
import { programEnvironment, readBinaries } from '../../tests/cargo-test.mts';

// cargoTestScript is the script that builds the test binary under the lease and copies it.
const cargoTestScript = new URL('../../tests/cargo-test.mts', import.meta.url).pathname;

/** The test entry of a coverage owner or dependent (contracts/features.json): the entry of a recipe, or a native entry of FCV-2. */
export type NativeCommand = { runner: string; test: string; cases: string[]; recipe?: string; symbol?: string; database?: string };
/** The owning client part of a feature. */
export type Owner = { part: string; tests: string[]; commands?: Record<string, NativeCommand[]> };
/** A dependent part of a feature. */
export type Dependent = { id: string; language: string; part: string; tests: string[]; cases: string[]; commands?: Record<string, NativeCommand[]> };
/** The coverage declaration of a feature. */
export type Coverage = { kind: string; cases: string[]; owners?: Record<string, Owner>; dependents?: Dependent[] };
/** A feature contract of contracts/features.json. */
export type Feature = { id: string; status?: string; parity?: string[]; coverage?: Coverage; tests?: string[] };
/** The feature manifest, contracts/features.json. */
export type Manifest = { features?: Feature[] };
/** One required execution: an owner or dependent part on one database. */
type Item = { key: string; role: 'owner' | 'dependent'; dependent?: string; language: string; database: string; part: string; tests: string[]; cases: string[]; command: NativeCommand[] | undefined; recipe?: boolean; selected?: boolean };
/** The report of one execution of an item. */
export type Report = { feature: string; role: string; language: string; database: string; part: string; tests: string[]; success: boolean; cases: string[]; dependent?: string };
/** The step writer of a running case or build. */
type StepWriter = (text: string) => void;
/** The outcome of run: an error message, or the collected output. */
type RunResult = { error?: string | null | undefined; value?: string | undefined; stdout: string; pid?: number | undefined };
/** A test entry planned for one execution: `cases` are the ids that must pass, read on `database` from its results file. */
type Spec = ({ format: 'process'; program: string; args: string[]; env?: Record<string, string> } | { format: 'go'; cwd: string; symbol: string } | { format: 'cargo'; cwd: string; testPath: string }) & { cases: string[]; database: string };
type CargoSpec = Extract<Spec, { format: 'cargo' }>;
/** A build of buildNative: its binary or its error. */
type Built = { binary: string; error?: undefined } | { error: string; binary?: undefined };
/** The Rust builds of a crate. */
type CargoBuilt = { files: Map<string, string[]>; filters: Map<string, string>; programs: Record<string, string>; error?: undefined } | { error: string; files?: undefined; filters?: undefined; programs?: undefined };
/** The builds that the executions share. */
type Builds = { go: Map<string, Built>; cargo: Map<string, CargoBuilt>; cargoReady: Promise<void> };
/** The planned executions of one item. */
type Plan = { feature: Feature; item: Item; native: Spec[] };
/** A process of a planned execution. */
type Prepared = { program: string; args: string[]; cwd?: string | undefined; label?: string; env?: Record<string, string> };

export const languages = implementationLanguages();
// claimedLanguages are the client languages of a feature: the ones its parity units bind. Each claimed language needs an owner.
const claimedLanguages = (feature: Feature, parityConfig?: ParityConfig): Set<string> =>
  new Set(featureLanguages(feature.parity ?? [], parityConfig));
export const databases = ['mysql', 'postgres', 'sqlite'];

const validPart = (part: unknown): part is string => typeof part === 'string' && part !== '' &&
  part.split('/').every(segment => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment));
const validTests = (part: string, tests: unknown): tests is string[] => Array.isArray(tests) && tests.length > 0 &&
  new Set(tests).size === tests.length && tests.every(file =>
    typeof file === 'string' && file.startsWith(part + '/') &&
    file.slice(part.length + 1).split('/').every(segment =>
      segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment)));

function requirements(feature: Feature, coverage: Coverage, errors: string[], parityConfig?: ParityConfig): Item[] {
  const selectedDatabase = selectedDatabases.get(feature);
  const selectedCases = selectedCasesByFeature.get(feature);
  const required = coverage.kind === 'database' ? (selectedDatabase ? [selectedDatabase] : databases) : ['none'];
  const items: Item[] = [];
  const claimed = claimedLanguages(feature, parityConfig);
  if (!coverage.owners || typeof coverage.owners !== 'object' || Array.isArray(coverage.owners))
    errors.push(`${feature.id}: missing owners`);
  for (const language of Object.keys(coverage.owners ?? {})) {
    if (!claimed.has(language)) errors.push(`${feature.id}/owner/${language}: undeclared owning client`);
  }
  if (!Array.isArray(coverage.dependents)) errors.push(`${feature.id}: missing dependents declaration`);
  for (const language of languages) {
    const owner = coverage.owners?.[language];
    const directory = testDirectoryOf(language);
    const validOwnerDirectory = owner?.part?.startsWith(`${directory}/`) || owner?.part === directory;
    if (!owner || !validPart(owner.part) || !validOwnerDirectory) {
      errors.push(`${feature.id}/owner/${language}: missing owning client part`);
      continue;
    }
    if (!validTests(owner.part, owner.tests) || owner.tests.some((file: string) =>
      (Array.isArray(coverage.dependents) ? coverage.dependents : []).some((dependent: Dependent | undefined) =>
        dependent?.language === language && typeof dependent.part === 'string' &&
        file.startsWith(dependent.part + '/')))) {
      errors.push(`${feature.id}/owner/${language}: tests must reside in owning part`);
      continue;
    }
    if (coverage.kind === 'database') {
      const boundTests = new Set(Object.entries(owner.commands ?? {})
        .filter(([database]) => databases.includes(database))
        .flatMap(([, commands]) => Array.isArray(commands) ? commands.map(entry => entry?.test) : []));
      for (const [, commands] of Object.entries(owner.commands ?? {}).filter(([database]) => databases.includes(database))) {
        if (Array.isArray(commands)) for (const entry of commands) {
          if (typeof entry?.test === 'string' && !owner.tests.includes(entry.test))
            errors.push(`${feature.id}/owner/${language}: database command test is undeclared: ${entry.test}`);
        }
      }
      for (const test of owner.tests) {
        if (!boundTests.has(test)) errors.push(`${feature.id}/owner/${language}: test has no database command: ${test}`);
      }
    }
    const ownerCases = selectedCases ? coverage.cases.filter(id => selectedCases.has(id)) : coverage.cases;
    for (const database of required) {
      const command = selectCommandCases(owner.commands?.[database], selectedCases);
      // The cases of a recipe owner are the cases of its recipe on this database (FCV-12), which entryTest compares.
      const recipe = Array.isArray(command) && command.some(entry => entry?.recipe);
      const tests = coverage.kind === 'database' || selectedCases || recipe
        ? [...new Set((command ?? []).map(entry => entry.test))] : owner.tests;
      items.push({ key: `${feature.id}/owner/${language}/${database}`,
        role: 'owner', language, database, part: owner.part, tests, recipe, selected: Boolean(selectedCases),
        cases: recipe ? (command ?? []).flatMap(entry => entry.cases) : ownerCases, command });
    }
  }
  const dependentIds = new Set<string>();
  for (const dependent of Array.isArray(coverage.dependents) ? coverage.dependents : []) {
    if (!dependent || typeof dependent.id !== 'string' || !dependent.id || dependentIds.has(dependent.id)) {
      errors.push(`${feature.id}: duplicate or missing dependent id`);
      continue;
    }
    dependentIds.add(dependent.id);
    if (!claimed.has(dependent.language) ||
        !validPart(dependent.part) || dependent.part === 'tests/conformance' ||
        dependent.part.startsWith('tests/conformance/') ||
        dependent.part === coverage.owners?.[dependent.language]?.part ||
        !Array.isArray(dependent.cases) || dependent.cases.length === 0 ||
        new Set(dependent.cases).size !== dependent.cases.length ||
        dependent.cases.some((id: unknown) => typeof id !== 'string' || !id) ||
        !validTests(dependent.part, dependent.tests) ||
        dependent.tests.some((file: string) => coverage.owners?.[dependent.language]?.tests?.includes(file))) {
      errors.push(`${feature.id}/dependent/${dependent.id}: invalid dependent part, tests, or cases`);
      continue;
    }
    if (selectedCases && !dependent.cases.some(id => selectedCases.has(id))) continue;
    for (const database of required) items.push({ key: `${feature.id}/dependent/${dependent.id}/${dependent.language}/${database}`,
      role: 'dependent', dependent: dependent.id, language: dependent.language, database,
      part: dependent.part, tests: dependent.tests,
      cases: selectedCases ? dependent.cases.filter(id => selectedCases.has(id)) : dependent.cases,
      command: selectCommandCases(dependent.commands?.[database], selectedCases) });
  }
  // When selectFeatures chose a coverage unit (--part), only the items of that unit are required and run.
  const selected = selectedParts.get(feature);
  if (selected) return items.filter(item => selected.has(itemPart(item)));
  return items;
}

// itemPart is the unit name of a coverage item: an owner client is `owner/<language>`, a dependent is `dependent/<id>`
// (same as coverageParts in scripts/features/owners.mts).
const itemPart = (item: Item): string => item.role === 'owner' ? `owner/${item.language}` : `dependent/${item.dependent}`;
// selectedParts is the unit chosen for each feature item made by selectFeatures. It does not change the feature items in the manifest.
const selectedParts = new WeakMap<Feature, Set<string>>();
const selectedDatabases = new WeakMap<Feature, string>();
const selectedCasesByFeature = new WeakMap<Feature, Set<string>>();

function selectCommandCases(command: NativeCommand[] | undefined, selectedCases: Set<string> | undefined): NativeCommand[] | undefined {
  if (!command || !selectedCases) return command;
  return command.map(entry => ({ ...entry, cases: entry.cases.filter(id => selectedCases.has(id)) })).filter(entry => entry.cases.length > 0);
}

// Reports in this function are constructed by executeCoverage from the exit status of each entry and the results file it
// wrote, never parsed from test JSON. An entry runs once (FCV-12): each case has a database of its own, so a second run
// observes nothing more.
export function checkCoverage(
  manifest: Manifest,
  reports: Record<string, Report[] | undefined>,
  parityConfig?: ParityConfig,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const expected = new Set<string>();
  for (const feature of manifest.features ?? []) {
    if (ids.has(feature.id)) errors.push(`duplicate feature ${feature.id}`);
    ids.add(feature.id);
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) {
      errors.push(`${feature.id}: missing coverage kind`);
      continue;
    }
    if (!Array.isArray(coverage.cases) || coverage.cases.length === 0 ||
        new Set(coverage.cases).size !== coverage.cases.length ||
        coverage.cases.some((id: unknown) => typeof id !== 'string' || !id)) {
      errors.push(`${feature.id}: coverage cases must be distinct nonempty IDs`);
      continue;
    }
    for (const item of requirements(feature, coverage, errors, parityConfig)) {
        const { key, language, database } = item;
        expected.add(key);
        const executions = reports[key];
        if (!executions) { errors.push(`${key}: no executed report`); continue; }
        if (!Array.isArray(executions) || executions.length !== 1) {
          errors.push(`${key}: exactly one execution required`);
          continue;
        }
        for (const report of executions) {
          if (!report || report.feature !== feature.id || report.language !== language || report.database !== database ||
              report.role !== item.role || report.part !== item.part ||
              (item.role === 'dependent' && report.dependent !== item.dependent))
            errors.push(`${key}: report identity differs`);
          if (!Array.isArray(report?.tests) || report.tests.length !== item.tests.length ||
              new Set(report.tests).size !== report.tests.length ||
              item.tests.some((file: string) => !report.tests.includes(file)))
            errors.push(`${key}: executed test paths differ from owning or dependent part`);
          if (report?.success !== true) errors.push(`${key}: execution failed`);
          const seen = report?.cases;
          if (!Array.isArray(seen) || new Set(seen).size !== seen.length ||
              seen.length !== item.cases.length ||
              item.cases.some(id => !seen.includes(id)))
            errors.push(`${key}: executed case IDs differ from contract`);
        }
    }
    if (feature.status === 'implemented' && languages.some(language => !claimedLanguages(feature, parityConfig).has(language)))
      errors.push(`${feature.id}: implemented feature lacks a parity unit in a client language`);
  }
  for (const key of Object.keys(reports)) {
    if (!expected.has(key)) errors.push(`${key}: undeclared execution report`);
  }
  return errors;
}

// run executes the program and collects its output. When there is a step, the stderr lines (cargo and go build progress)
// are sent as steps while it runs. stdout is test events, so it is only collected and read.
// run executes the program and collects its output. When there is a step, the stderr lines (cargo and go build progress)
// are sent as steps while it runs. stdout is test events, so it is only collected and read. limit is
// the maximum length of the output being collected. Test output does not exceed 1000000 characters, but build JSON messages are one line per dependency, so
// the line is longer. timeoutMs is the deadline of the executed process, and a long-running build runs with null, meaning no deadline.
export function run(program: string, args: string[], cwd: string | undefined, timeoutMs: number | null, env: NodeJS.ProcessEnv = process.env, step?: StepWriter, limit = 1_000_000): Promise<RunResult> {
  return new Promise<RunResult>((finish) => {
    const child = spawn(program, args, { cwd, env, detached: true });
    const progress = step ? stepLines(step) : null;
    let output = '';
    let stdout = '';
    let stderr = '';
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (errorCode(error) !== 'ESRCH') throw error; }
    };
    const done = (error: string | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ error, value, stdout, pid: child.pid });
    };
    const append = (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > limit) stop();
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); append(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); append(chunk); progress?.write(String(chunk)); });
    child.on('error', error => done(error.message));
    // The child is the leader of its own group. A process left in that group after it ends is treated as a failure (endGroup).
    const ended = new Promise<string[]>(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, (error: unknown) => resolve([`its group could not be checked: ${error instanceof Error ? error.message : String(error)}`]))));
    child.on('close', async (code, signal) => {
      progress?.flush();
      const left = await ended;
      if (left.length) {
        const diagnostics = [
          stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
          stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
        ].filter(Boolean).join('\n');
        return done(`${program} left ${left.length} processes: ${left.join(', ')}${diagnostics ? `\n${diagnostics}` : ''}`);
      }
      if (output.length > limit) return done(`test output exceeds ${limit} characters`);
      if (code !== 0) return done(code === null
        ? `signal ${signal ?? 'unknown'}: ${output.trim()}`
        : `exit ${code}: ${output.trim()}`);
      done(null, output);
    });
    // When timeoutMs is null, it is a long-running build, so no timer is set.
    const timer: NodeJS.Timeout | undefined = timeoutMs === null ? undefined : setTimeout(() => {
      stop();
      // The run reports a process that has ended: a killed child is gone once its exit event fires. A child that did not start
      // or has already exited sends no further exit event.
      const timedOut = () => done(`timeout after ${timeoutMs} ms`);
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) timedOut();
      else child.once('exit', timedOut);
    }, timeoutMs);
  });
}

// recipeOutput is the lines a recipe runner wrote; a run in which no case passed wrote no file.
async function recipeOutput(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return '';
  }
}

// recipeCaseIds is the ids of the cases of a recipe file that run on database: a case with `only` runs on the databases it
// names (FCV-3). The recipe is the list of the cases of its owner.
export function recipeCaseIds(text: string, database: string): string[] {
  return parseRecipeCases(text, 'recipe').cases.filter(item => item.only === undefined || item.only.includes(database)).map(item => item.id);
}

// entryTest plans a test entry (FCV-12). Every runtime runs the entry with its own test runner and the entry appends a
// `CASE` line for each case that passed to the file of ORM_RECIPE_RESULTS, so that one reader reads every runtime. The entry
// takes no case argument and no database of the bench: the cases of a recipe are the recipe's and each gets a case database from
// the run (FCV-9). A native entry of FCV-2 names its cases itself and has no database.
const ENTRY_KEYS = ['runner', 'test', 'cases', 'recipe', 'symbol', 'database'];
const RUNNER_OF_LANGUAGE: Record<string, string | undefined> = { typescript: 'node', php: 'php', 'php-extension': 'php', python: 'python', go: 'go', rust: 'cargo' };
const EXTENSION_OF_RUNNER: Record<string, string | undefined> = { node: '.mjs', php: '.php', python: '.py', go: '.go', cargo: '.rs' };

async function entryTest(item: Item, command: NativeCommand, root: string): Promise<Spec> {
  const recipe = command.recipe;
  const named = command.runner === 'go' || command.runner === 'php';
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).some(key => !ENTRY_KEYS.includes(key)) || !item.tests.includes(command.test) ||
      command.runner !== RUNNER_OF_LANGUAGE[item.language] || extname(command.test ?? '') !== EXTENSION_OF_RUNNER[command.runner] ||
      (recipe !== undefined && (!(recipe.startsWith('contracts/fixtures/') || recipe.startsWith('tests/')) || !recipe.endsWith('.json'))) ||
      (recipe === undefined && (item.database !== 'none' || command.database !== undefined)) ||
      (named ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(command.symbol ?? '') : command.symbol !== undefined) ||
      !Array.isArray(command.cases) || new Set(command.cases).size !== command.cases.length ||
      (recipe === undefined && (command.cases.length === 0 || command.cases.some(id => !item.cases.includes(id)))))
    throw new Error('invalid test command');
  const testPath = resolve(root, command.test);
  if (await realpath(testPath) !== testPath) throw new Error('symbolic test path');
  // An independent owner whose behaviour is a case of a recipe with a database names the one database its entry runs on.
  if (command.database !== undefined && (item.database !== 'none' || !databases.includes(command.database)))
    throw new Error('invalid test command');
  const database = command.database ?? item.database;
  const cases = recipe === undefined ? command.cases : recipeCaseIds(await readFile(resolve(root, recipe), 'utf8'), database);
  const declared = [...command.cases].sort();
  const listed = [...cases].sort();
  if (command.cases.some(id => !cases.includes(id)) ||
      (!item.selected && (declared.length !== listed.length || declared.some((id, index) => id !== listed[index]))))
    throw new Error(`cases differ from recipe ${recipe}: declared ${declared.join(',')}; recipe ${listed.join(',')}`);
  const symbol = command.symbol ?? '';
  const directory = resolve(root, testDirectoryOf(item.language));
  if (command.runner === 'node')
    return { format: 'process', program: 'node', args: ['--conditions=orm-test', '--test', testPath], cases, database };
  if (command.runner === 'python') {
    if (!process.env.ORM_PYTHON) throw new Error('ORM_PYTHON is unset; run this through make, which exports it');
    const module = relative(root, testPath).replace(/\.py$/, '').split(sep).join('.');
    return { format: 'process', program: process.env.ORM_PYTHON, args: ['-m', module], cases, database };
  }
  if (command.runner === 'php') {
    const extension = item.language === 'php-extension' ? process.env.POLYSPEC_ORM_EXTENSION : undefined;
    if (item.language === 'php-extension' && !extension)
      throw new Error('POLYSPEC_ORM_EXTENSION is unset; run this through make, which builds the extension and exports it');
    return { format: 'process', program: 'php', cases, database,
      args: [...(extension ? ['-d', `extension=${extension}`] : []), resolve(root, 'vendor-php/bin/phpunit'),
        '--configuration', resolve(directory, 'phpunit.xml.dist'), '--filter', `/::${symbol}( |$)/`, testPath],
      ...(item.language === 'php-extension' ? { env: { ORM_PHP_MODE: 'extension' } } : {}) };
  }
  if (command.runner === 'go') {
    if (!new RegExp(`\\bfunc\\s+${symbol}\\s*\\(`).test(await readFile(testPath, 'utf8'))) throw new Error(`test symbol ${symbol} is absent from declared test file`);
    return { format: 'go', cwd: dirname(testPath), symbol, cases, database };
  }
  const program = (await programModules(root)).has(testPath) ? resolve(root, RUST_TEST_PROGRAM_CRATE) : undefined;
  return { format: 'cargo', cwd: program ?? await owningCrate(testPath, resolve(root, item.part)), testPath, cases, database };
}

// owningCrate is the directory of the Cargo manifest of a Rust test file, within the part of its owner.
async function owningCrate(testPath: string, part: string): Promise<string> {
  let crate = dirname(testPath);
  while (crate.startsWith(part)) {
    try { await realpath(resolve(crate, 'Cargo.toml')); return crate; }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      crate = dirname(crate);
    }
  }
  throw new Error('Rust test has no owning Cargo manifest');
}

// resultCases reads the cases of one execution of an item on `database` ('none' for an item without a database) from the lines
// its entry appended: `CASE <id> [<database>] PASS`, or `CASE <id> PASS` without a database (FCV-12). A case without a line did not
// pass; a skipped test writes none.
export function resultCases(output: string, requested: string[], database = 'none'): string[] {
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = database === 'none' ? /^CASE ([A-Za-z0-9_.-]+) PASS$/.exec(line) : /^CASE ([A-Za-z0-9_.-]+) \[([a-z]+)\] PASS$/.exec(line);
    if (!match || (database !== 'none' && match[2] !== database)) throw new Error(`unexpected test output: ${line}`);
    const id = match[1] ?? '';
    if (seen.has(id)) throw new Error(`duplicate observed case ${id}`);
    seen.add(id);
  }
  if (seen.size !== requested.length || requested.some(id => !seen.has(id))) {
    // An empty set is written as `observed no cases`. If the list were empty, what follows `observed cases` would look blank.
    const observed = seen.size === 0 ? 'observed no cases' : `observed cases ${[...seen].join(',')}`;
    throw new Error(`${observed} differ from ${requested.join(',')}`);
  }
  return requested;
}

// dependencyFiles reads from the first rule of the dep-info (<binary>.d) that rustc writes next to the test binary, the
// list of source files the binary was compiled from. Spaces in paths are escaped with a backslash, and
// cargo compiles workspace members by paths relative to the workspace root, so relative paths
// are resolved against the workspace.
async function dependencyFiles(executable: string, workspace: string): Promise<string[]> {
  const text = await readFile(`${executable}.d`, 'utf8');
  const rule = text.split('\n', 1)[0] ?? '';
  const separator = rule.indexOf(': ');
  if (separator < 0) throw new Error(`dep-info of ${executable} has no rule`);
  return rule.slice(separator + 2).split(/(?<!\\) +/).filter(Boolean).map(path => resolve(workspace, path.replaceAll('\\ ', ' ')));
}

// buildNative builds once each before the coverage cases. Go
// per package, the `go test -c` test binary; per Rust crate, the output of `cargo test --no-run`
// test binary. Every database executes the same binary. One build is a long-running task
// that starts once, reports progress (compiler output), exit code, result and elapsed time, and has no deadline (runLong). A failed
// build stays as an error in builds, and the runs that use that build fail with that error. The Go build
// returns after it finishes, and the longest Rust build only starts and returns: builds.cargoReady
// is a promise that settles once builds.cargo is filled. So runs that do not use cargo proceed alongside the Rust build.
/** The plans of one coverage run, with the repository root they resolve against. */
type Plans = Plan[] & { root: string };
/** A build with its name; it returns null when it passes, otherwise its error. */
type Build = (name: string, work: (step: StepWriter) => Promise<void>) => Promise<string | null | undefined>;

async function buildNative(plans: Plans, directory: string): Promise<Builds> {
  const builds: Builds = { go: new Map(), cargo: new Map(), cargoReady: Promise.resolve() };
  const build: Build = async (name, work) => {
    let failure: string | undefined;
    const passed = await runLong(`features/coverage/build/${name}`, async ({ step }) => {
      try { await work(step); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
      step('exit 0');
    });
    return passed ? null : failure;
  };
  const go = async (args: string[], cwd: string, step: StepWriter) => {
    const result = await run('go', args, cwd, null, process.env, step);
    if (result.error) throw new Error(result.error);
  };
  const specs = plans.flatMap(plan => plan.native);
  for (const cwd of new Set(specs.filter(spec => spec.format === 'go').map(spec => spec.cwd))) {
    const binary = resolve(directory, `go-${builds.go.size}.test`);
    const error = await build(`go/${relative(plans.root, cwd)}`, step =>
      go(['test', '-c', '-tags', goBuildTags, '-o', binary, '.'], cwd, step));
    builds.go.set(cwd, error ? { error } : { binary });
  }
  builds.cargoReady = buildCargo(plans, directory, builds, build);
  return builds;
}

// goBuildTags are the build tags of the normal go test, so that the checker reads a test the normal run holds.
const goBuildTags = GO_TEST_TAGS.join(',');

// buildCargo builds only the Rust test targets selected by the coverage plans.
// A failure stays as an error in builds.cargo, so this promise is not rejected.
type CargoTarget = { name: string; kind: string[]; src_path: string; test: boolean; harness?: boolean };
type CargoDependency = { name: string; rename?: string | null };
type CargoPackage = { name: string; manifest_path: string; targets: CargoTarget[]; features: Record<string, string[]>; dependencies: CargoDependency[] };
type CargoMetadata = { packages?: CargoPackage[]; workspace_root?: string };

/** The field `key` of the JSON object `value`, read as unknown. */
function jsonField(value: object, key: string): unknown {
  const field: unknown = Reflect.get(value, key);
  return field;
}

/** The JSON object `value`; another JSON value throws, naming `what`. */
function jsonObject(value: unknown, what: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is no JSON object`);
  return value;
}

/** The string `value`; another JSON value throws, naming `what`. */
function jsonString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is no string`);
  return value;
}

/** The objects of the JSON array `value`; another JSON value throws, naming `what`. */
function jsonObjects(value: unknown, what: string): object[] {
  if (!Array.isArray(value)) throw new Error(`${what} is no array`);
  return value.map((entry: unknown, index) => jsonObject(entry, `${what}[${index}]`));
}

/** The packages and workspace root of the output of `cargo metadata --format-version=1`, checked field by field. */
function cargoMetadataOf(text: string): CargoMetadata {
  const value = jsonObject(JSON.parse(text), 'cargo metadata');
  const root = jsonField(value, 'workspace_root');
  const packages = jsonObjects(jsonField(value, 'packages'), 'cargo metadata packages').map((entry, index): CargoPackage => {
    const where = `cargo metadata packages[${index}]`;
    const targets = jsonObjects(jsonField(entry, 'targets'), `${where}.targets`).map((target, number): CargoTarget => {
      const at = `${where}.targets[${number}]`;
      const kind = jsonField(target, 'kind');
      if (!Array.isArray(kind)) throw new Error(`${at}.kind is no array`);
      const test = jsonField(target, 'test');
      if (typeof test !== 'boolean') throw new Error(`${at}.test is no boolean`);
      const harness = jsonField(target, 'harness');
      if (harness !== undefined && typeof harness !== 'boolean') throw new Error(`${at}.harness is no boolean`);
      return {
        name: jsonString(jsonField(target, 'name'), `${at}.name`),
        kind: kind.map((entry: unknown, k) => jsonString(entry, `${at}.kind[${k}]`)),
        src_path: jsonString(jsonField(target, 'src_path'), `${at}.src_path`),
        test,
        ...(harness === undefined ? {} : { harness }),
      };
    });
    const rawFeatures = jsonObject(jsonField(entry, 'features'), `${where}.features`);
    const features = Object.fromEntries(Object.entries(rawFeatures).map(([name, value]) => {
      if (!Array.isArray(value)) throw new Error(`${where}.features.${name} is no array`);
      return [name, value.map((feature: unknown, number) => jsonString(feature, `${where}.features.${name}[${number}]`))];
    }));
    const dependencies = jsonObjects(jsonField(entry, 'dependencies'), `${where}.dependencies`).map((dependency, number): CargoDependency => {
      const at = `${where}.dependencies[${number}]`;
      const rename = jsonField(dependency, 'rename');
      if (rename !== undefined && rename !== null && typeof rename !== 'string') throw new Error(`${at}.rename is not a string or null`);
      return { name: jsonString(jsonField(dependency, 'name'), `${at}.name`), ...(rename === undefined ? {} : { rename }) };
    });
    return { name: jsonString(jsonField(entry, 'name'), `${where}.name`), manifest_path: jsonString(jsonField(entry, 'manifest_path'), `${where}.manifest_path`), targets, features, dependencies };
  });
  return { packages, ...(root === undefined ? {} : { workspace_root: jsonString(root, 'cargo metadata workspace_root') }) };
}

/** The crate of the one Rust test program, and its root file, which runs as a group each test module of a test case crate. */
export const RUST_TEST_PROGRAM_CRATE = 'packages/rust/tests';
const RUST_TEST_PROGRAM_ROOT = `${RUST_TEST_PROGRAM_CRATE}/tests/all/main.rs`;

/** The test modules of test case crates that a root file of a test program runs, by the file of each: `polyspec_orm_<package>_cases`, or `polyspec_orm_cases` of the package orm, holds them in `<package>/tests/cases`. */
export function programCaseModules(rootFile: string, text: string): Map<string, string> {
  const packages = resolve(dirname(rootFile), '../../..');
  const modules = new Map<string, string>();
  for (const match of text.matchAll(/\bpolyspec_orm(?:_(\w+?))?_cases::(\w+)::trials\b/g)) {
    if (match[2]) modules.set(resolve(packages, match[1] ?? 'orm', 'tests/cases', `${match[2]}.rs`), match[2]);
  }
  return modules;
}

/** The modules of the one Rust test program, by file. */
async function programModules(root: string): Promise<Map<string, string>> {
  const file = resolve(root, RUST_TEST_PROGRAM_ROOT);
  try {
    return programCaseModules(file, await readFile(file, 'utf8'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return new Map();
  }
}

/** The files included by an explicit Rust #[path] declaration in a library target. */
export async function cargoPathModuleFiles(targets: CargoTarget[]): Promise<{ target: string; file: string }[]> {
  const modules: { target: string; file: string }[] = [];
  for (const target of targets.filter(candidate => candidate.test && candidate.kind.includes('lib'))) {
    const root = dirname(resolve(target.src_path));
    const pending = [root];
    const sources: string[] = [];
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && extname(path) === '.rs') sources.push(path);
      }
    }
    for (const source of sources) {
      const text = await readFile(source, 'utf8');
      for (const match of text.matchAll(/#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*mod\b/g)) {
        if (match[1]) modules.push({ target: target.name, file: resolve(dirname(source), match[1]) });
      }
    }
  }
  return modules;
}

/** Select Cargo test targets that own the declared source files. */
export function cargoTargetArgs(targets: CargoTarget[], testPaths: string[], pathModules: { target: string; file: string }[] = []): string[] {
  const selected = new Map<string, CargoTarget>();
  for (const file of testPaths) {
    const path = resolve(file);
    const candidates = targets.flatMap(target => {
      if (!target.test || target.harness === false) return [];
      if (pathModules.some(module => module.target === target.name && resolve(module.file) === path)) return [{ target, specificity: path.length + 2 }];
      const source = resolve(target.src_path);
      if (source === path) return [{ target, specificity: path.length + 1 }];
      const roots = [dirname(source)];
      const stem = basename(source, '.rs');
      if (stem !== 'lib' && stem !== 'main') roots.push(join(dirname(source), stem));
      const matches = roots.filter(root => path.startsWith(`${root}${sep}`));
      const specificity = matches.length ? Math.max(...matches.map(root => root.length)) : -1;
      return specificity < 0 ? [] : [{ target, specificity }];
    });
    const longest = Math.max(-1, ...candidates.map(candidate => candidate.specificity));
    const best = candidates.filter(candidate => candidate.specificity === longest);
    if (best.length !== 1)
      throw new Error(`Rust test ${file} maps to ${best.length} Cargo test targets at its most specific module root`);
    const target = best[0]?.target;
    if (!target) throw new Error(`Rust test ${file} has no Cargo test target`);
    selected.set(`${target.kind.join(',')}:${target.name}`, target);
  }
  const args: string[] = [];
  for (const target of selected.values()) {
    if (target.kind.includes('test')) args.push('--test', target.name);
    else if (target.kind.includes('lib')) args.push('--lib');
    else if (target.kind.includes('bin')) args.push('--bin', target.name);
    else if (target.kind.includes('example')) args.push('--example', target.name);
    else throw new Error(`unsupported Cargo test target kind for ${target.name}: ${target.kind.join(', ')}`);
  }
  return args;
}

/** Returns the canonical manifest of the workspace reported by Cargo metadata. */
export function cargoWorkspaceManifestPath(workspaceRoot: string | undefined): string {
  if (!workspaceRoot) throw new Error('cargo metadata has no workspace_root');
  return resolve(workspaceRoot, 'Cargo.toml');
}

/** Keep only shared feature requests applicable to the selected package or its direct dependencies. */
export function cargoFeaturesForPackage(project: CargoMetadata, selectedPackage: CargoPackage, requested: string[]): string[] {
  const dependencies = new Map(selectedPackage.dependencies.map(dependency => [dependency.rename ?? dependency.name, dependency.name]));
  const applicable = requested.filter(request => {
    const slash = request.indexOf('/');
    if (slash <= 0 || slash === request.length - 1) throw new Error(`invalid qualified Rust test feature ${request}`);
    const packageName = request.slice(0, slash);
    const featureName = request.slice(slash + 1);
    if (packageName === selectedPackage.name) return Object.hasOwn(selectedPackage.features, featureName);
    const dependencyName = dependencies.get(packageName);
    const dependency = project.packages?.find(packageInfo => packageInfo.name === dependencyName);
    return dependency !== undefined && Object.hasOwn(dependency.features, featureName);
  });
  return applicable.length ? ['--features', applicable.join(',')] : [];
}

/**
 * The name filter of a test file that is a module of a Cargo test target: the trials of a module are `<module path>::<name>`, and a
 * test program holds many modules. The root file of a target has no filter: its binary runs what it holds.
 */
export function cargoModuleFilter(targets: CargoTarget[], testPath: string): string | undefined {
  const path = resolve(testPath);
  const owners = targets.filter(target => target.test && target.kind.includes('test') && path.startsWith(`${dirname(resolve(target.src_path))}${sep}`));
  const owner = owners.sort((left, right) => right.src_path.length - left.src_path.length)[0];
  if (owner === undefined || resolve(owner.src_path) === path || !['main.rs', 'lib.rs'].includes(basename(owner.src_path))) return undefined;
  const parts = relative(dirname(resolve(owner.src_path)), path).replace(/\.rs$/, '').split(sep);
  if (parts.at(-1) === 'mod') parts.pop();
  return `${parts.join('::')}::`;
}

/** Builds only the selected package's Rust test targets from the canonical workspace manifest. */
export function cargoBuildArgs(workspaceManifestPath: string, packageName: string, features: string[], targetArgs: string[]): string[] {
  return ['cargo', 'test', '--no-run', '--manifest-path', workspaceManifestPath, '--package', packageName,
    ...features, ...targetArgs, '--message-format=json-render-diagnostics'];
}
async function buildCargo(plans: Plans, directory: string, builds: Builds, build: Build): Promise<void> {
  const specs = plans.flatMap(plan => plan.native);
  const cargoCrates = new Map<string, CargoSpec[]>();
  for (const spec of specs.filter((entry): entry is CargoSpec => entry.format === 'cargo'))
    cargoCrates.set(spec.cwd, [...(cargoCrates.get(spec.cwd) ?? []), spec]);
  const requestedFeatures = process.env.ORM_RUST_TEST_FEATURES?.split(',').filter(Boolean) ?? [];
  for (const [crate, crateSpecs] of cargoCrates) {
    const files = new Map<string, string[]>();
    const filters = new Map<string, string>();
    let programPaths: Record<string, string> = {};
    const error = await build(`cargo/${relative(plans.root, crate) || '.'}`, async step => {
      // The build and the copy are done under an exclusive lease on the shared Rust target directory (tests/cargo-test.mts --copy). Runs
      // use the binary copied into this checker's directory, so even if a build from another run in this checkout changes the target directory, this
      // run's test binary does not change.
      const { LEASE: lease, CARGO_LEASES: leases } = process.env;
      if (!lease || !leases) throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
      const manifestPath = resolve(crate, 'Cargo.toml');
      const metadata = await run('cargo', ['metadata', '--no-deps', '--format-version=1', '--manifest-path', manifestPath], crate, null, process.env, step, 10_000_000);
      if (metadata.error) throw new Error(`cargo metadata: ${metadata.error}`);
      const project = cargoMetadataOf(metadata.stdout ?? '');
      const selectedPackage = project.packages?.find(packageInfo => resolve(packageInfo.manifest_path) === manifestPath);
      if (!selectedPackage) throw new Error(`cargo metadata did not return package for ${manifestPath}`);
      const workspaceManifestPath = cargoWorkspaceManifestPath(project.workspace_root);
      const features = cargoFeaturesForPackage(project, selectedPackage, requestedFeatures);
      const dependencyRoot = dirname(workspaceManifestPath);
      const pathModules = await cargoPathModuleFiles(selectedPackage.targets);
      const program = selectedPackage.targets.find(target => target.kind.includes('test') && resolve(target.src_path) === resolve(plans.root, RUST_TEST_PROGRAM_ROOT));
      const included = program === undefined ? new Map<string, string>() : await programModules(plans.root);
      if (program !== undefined) pathModules.push(...[...included.keys()].map(file => ({ target: program.name, file })));
      const targetArgs = cargoTargetArgs(selectedPackage.targets, crateSpecs.map(spec => spec.testPath), pathModules);
      for (const { testPath } of crateSpecs) {
        const name = included.get(testPath);
        const filter = name === undefined ? cargoModuleFilter(selectedPackage.targets, testPath) : `${name}::`;
        if (filter !== undefined) filters.set(testPath, filter);
      }
      const copies = resolve(directory, `cargo-${builds.cargo.size}-${relative(plans.root, crate).replaceAll('/', '_') || 'root'}`);
      await mkdir(copies, { recursive: true });
      const result = await run(lease, ['run', leases, 'exclusive', '--wait', '--', process.execPath, cargoTestScript, '--copy', copies, '--',
        ...cargoBuildArgs(workspaceManifestPath, selectedPackage.name, features, targetArgs)], crate, null, process.env, step, 100_000_000);
      if (result.error) throw new Error(result.error);
      const copied = readBinaries(copies);
      programPaths = programEnvironment(copied.programs);
      for (const binary of copied.tests) {
        for (const file of await dependencyFiles(binary.copy, dependencyRoot)) {
          files.set(file, [...(files.get(file) ?? []), binary.copy]);
        }
      }
      // A test case crate is a library of the program, so the dep-info of the program does not list its modules.
      for (const binary of copied.tests.filter(candidate => candidate.target === program?.name)) {
        for (const file of included.keys()) files.set(file, [...(files.get(file) ?? []), binary.copy]);
      }
      step(`${new Set([...files.values()].flat()).size} test binaries`);
    });
    builds.cargo.set(crate, error ? { error } : { files, filters, programs: programPaths });
  }
}

// prepared turns one spec into the list of processes that run the built binary. For Rust, each test binary compiled from the
// declared test file runs in turn (--test-threads=1), since the tests of one entry can write the same row.
// The Rust test binary receives the crate's package directory as CARGO_MANIFEST_DIR, as cargo test does:
// the test gets the fixture path from the value at run time (polyspec_orm_testcase::manifest_dir).
function prepared(spec: Spec, builds: Builds, root: string): Prepared[] {
  if (spec.format === 'process')
    return [{ program: spec.program, args: spec.args, cwd: root, ...(spec.env ? { env: spec.env } : {}) }];
  if (spec.format === 'go') {
    const binary = builds.go.get(spec.cwd);
    if (!binary || binary.error !== undefined) throw new Error(`go test build failed: ${binary?.error ?? 'it was not built'}`);
    return [{ program: binary.binary, args: ['-test.count=1', '-test.run', `^${spec.symbol}$`], cwd: spec.cwd, label: `go test ${binary.binary} -test.run ^${spec.symbol}$` }];
  }
  const crate = builds.cargo.get(spec.cwd);
  if (!crate || crate.error !== undefined) throw new Error(`cargo test build failed: ${crate?.error ?? 'it was not built'}`);
  const executables = crate.files.get(spec.testPath) ?? [];
  if (executables.length === 0) throw new Error(`no test binary compiles ${spec.testPath}`);
  const filter = crate.filters.get(spec.testPath);
  return executables.map((executable: string) => ({ program: executable, args: ['--test-threads=1', ...(filter === undefined ? [] : [filter])], cwd: spec.cwd,
    env: { ...crate.programs, CARGO_MANIFEST_DIR: spec.cwd } }));
}

// usesCargo is whether the run uses the cargo test binary (the Rust build of buildNative).
const usesCargo = (plan: Plan): boolean => plan.native.some(spec => spec.format === 'cargo');

// The deadline of executeCoverage.
// timeoutMs: the deadline of one process that a run starts, the test binary or test runner of an entry. The
// case keeps its own deadline through its own level (testcase.Start, caseTest), so this deadline is the outer
// boundary that ends a stuck process, and is not shorter than the longest declarable level PROCESS (5 minutes). The build before it is a long-running task, so it has no deadline.
export const NATIVE_DEADLINE = PROCESS;
export async function executeCoverage(
  manifest: Manifest,
  root: string,
  timeoutMs = NATIVE_DEADLINE,
  parityConfig?: ParityConfig,
): Promise<string[]> {
  const reports: Record<string, Report[]> = {};
  const errors: string[] = [];
  const plans: Plans = Object.assign([] as Plan[], { root });
  for (const feature of manifest.features ?? []) {
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) continue;
    for (const item of requirements(feature, coverage, errors, parityConfig)) {
        const { key, command } = item;
        if (!command) {
          errors.push(`${key}: no executable command`);
          continue;
        }
        const cwd = resolve(root, item.part);
        if (!cwd.startsWith(resolve(root) + '/')) {
          errors.push(`${key}: invalid part directory`);
          continue;
        }
        try {
          if (await realpath(cwd) !== cwd) throw new Error('symbolic path');
          for (const file of item.tests) {
            const target = resolve(root, file);
            if (await realpath(target) !== target) throw new Error(`symbolic test path ${file}`);
          }
        } catch (error) {
          errors.push(`${key}: unavailable part directory: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        let native: Spec[];
        try {
          if (!Array.isArray(command) || command.length !== item.tests.length ||
              new Set(command.map(entry => entry?.test)).size !== item.tests.length ||
              item.tests.some(test => !command.some(entry => entry?.test === test)) ||
              command.flatMap(entry => entry?.cases ?? []).length !== item.cases.length ||
              new Set(command.flatMap(entry => entry?.cases ?? [])).size !== item.cases.length ||
              item.cases.some(id => !command.some(entry => entry?.cases?.includes(id))))
            throw new Error('invalid test command');
          native = await Promise.all(command.map(entry => entryTest(item, entry, root)));
        }
        catch (error) { errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        plans.push({ feature, item, native });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'orm-coverage-'));
  let builds: Builds | undefined;
  try {
    builds = await buildNative(plans, directory);
    await Promise.all([...Map.groupBy(plans, plan => plan.item.database).values()]
      .map(lane => runLane([...lane.filter(plan => !usesCargo(plan)), ...lane.filter(usesCargo)])));
  } finally {
    // Before deleting the temporary directory, wait for the Rust build (which copies the binary into that directory) to finish.
    await builds?.cargoReady;
    await rm(directory, { recursive: true, force: true });
  }
  return [...errors, ...checkCoverage(manifest, reports, parityConfig)];

  async function runLane(lane: Plan[]): Promise<void> {
    for (const plan of lane) {
      const { feature, item, native } = plan;
      const { key, command } = item;
      if (usesCargo(plan)) await builds?.cargoReady;
      const shared = builds;
      if (!shared || !command) continue;
      const executions: Report[] = [];
      reports[key] = executions;
      let processes: Prepared[][];
      try { processes = native.map(spec => prepared(spec, shared, root)); }
      catch (error) { errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      // The deadline of a run is the sum of those of its processes. A process runs the cases of its entry, each with its own
      // deadline, so it holds one deadline per case.
      const processDeadline = (spec: Spec | undefined): number => timeoutMs * Math.max(1, spec?.cases.length ?? 1);
      const runDeadline = processes.reduce((sum, children, index) => sum + children.length * processDeadline(native[index]), 0);
      let failure: string | undefined;
      const passed = await runCase(`${key} run`, runDeadline, async ({ step }) => {
        let caught = false;
        try {
            for (let index = 0; index < native.length; index++) {
            const spec = native[index];
            const entry = command[index];
            if (!spec || !entry) throw new Error(`no test entry ${index}`);
            const results = join(directory, `${key.replaceAll('/', '_')}-${index}.results`);
            for (const child of processes[index] ?? []) {
              step(child.label ?? `${child.program} ${entry.test}`);
              const result = await run(child.program, child.args, child.cwd, processDeadline(spec), { ...process.env, ...child.env, ORM_RECIPE_RESULTS: results }, step);
              if (result.error) throw new Error(result.error);
            }
            resultCases(await recipeOutput(results), spec.cases, spec.database);
          }
          executions.push({ feature: feature.id, role: item.role, language: item.language,
            database: item.database, part: item.part, tests: item.tests, success: true,
            cases: item.cases, ...(item.dependent ? { dependent: item.dependent } : {}) });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          caught = true;
        }
        if (caught) throw new Error(failure);
      });
      if (!passed) errors.push(`${key}: ${failure ?? `deadline ${runDeadline} ms exceeded`}`);
    }
  }
}

// selectFeatures keeps only the one feature whose featureId (the id in contracts/features.json, as with check.mts --feature)
// manifest. If parts (`owner/<language>` or `dependent/<id>`) are given, only that coverage unit is run and checked.
// An unknown id or unit is an error listing the values that can be chosen, not an empty run.
export function selectFeatures(
  manifest: Manifest,
  featureId: string | undefined,
  parts: string[] = [],
  selectedDatabase?: string,
  selectedCases: string[] = [],
): Manifest & { features: Feature[] } {
  if (featureId === undefined) {
    if (parts.length) throw new Error('--part needs --feature');
    if (selectedDatabase !== undefined || selectedCases.length) throw new Error('--database and --case need --feature');
    return { ...manifest, features: manifest.features ?? [] };
  }
  const feature = manifest.features?.find(item => item.id === featureId);
  if (!feature)
    throw new Error(`unknown feature ${featureId}; valid features: ${(manifest.features ?? []).map(item => item.id).join(', ')}`);
  if (selectedDatabase !== undefined) {
    if (!databases.includes(selectedDatabase))
      throw new Error(`unknown coverage database ${selectedDatabase}; valid databases: ${databases.join(', ')}`);
    if (feature.coverage?.kind !== 'database')
      throw new Error(`${featureId} has no database coverage to select`);
  }
  if (selectedCases.length) {
    if (new Set(selectedCases).size !== selectedCases.length)
      throw new Error('--case must not be repeated');
    const validCases = feature.coverage?.cases ?? [];
    const unknown = selectedCases.filter(id => !validCases.includes(id));
    if (unknown.length) throw new Error(`unknown coverage case ${unknown.join(', ')} of ${featureId}; valid cases: ${validCases.join(', ')}`);
  }
  if (parts.length === 0 && selectedDatabase === undefined && selectedCases.length === 0)
    return { ...manifest, features: [feature] };
  const valid = [...Object.keys(feature.coverage?.owners ?? {}).map(language => `owner/${language}`),
    ...(feature.coverage?.dependents ?? []).map(dependent => `dependent/${dependent.id}`)];
  const unknown = parts.filter(part => !valid.includes(part));
  if (unknown.length) throw new Error(`unknown coverage part ${unknown.join(', ')} of ${featureId}; valid parts: ${valid.join(', ')}`);
  const copy = { ...feature };
  if (parts.length) selectedParts.set(copy, new Set(parts));
  if (selectedDatabase !== undefined) selectedDatabases.set(copy, selectedDatabase);
  if (selectedCases.length) {
    if (!feature.coverage) throw new Error(`${featureId} has no coverage cases to select`);
    copy.coverage = { ...feature.coverage, cases: selectedCases };
    selectedCasesByFeature.set(copy, new Set(selectedCases));
  }
  return { ...manifest, features: [copy] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const pairs: [string | undefined, string | undefined][] = [];
  for (let index = 0; index < args.length; index += 2) pairs.push([args[index], args[index + 1]]);
  if (pairs.some(([flag, value]) => !['--feature', '--part', '--database', '--case'].includes(flag ?? '') || !value) ||
      pairs.filter(([flag]) => flag === '--feature').length > 1 || pairs.filter(([flag]) => flag === '--database').length > 1)
    throw new Error('usage: coverage.mts [--feature <id> [--part owner/<language>|dependent/<id>] [--database <db>] [--case <id>]...]');
  const featureId = pairs.find(([flag]) => flag === '--feature')?.[1];
  const parts = pairs.filter(([flag]) => flag === '--part').map(([, value]) => value ?? '');
  const database = pairs.find(([flag]) => flag === '--database')?.[1];
  const cases = pairs.filter(([flag]) => flag === '--case').map(([, value]) => value ?? '');
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const manifest: Manifest = readFeatures(root);
  let selected: Manifest & { features: Feature[] };
  try {
    selected = selectFeatures(manifest, featureId, parts, database, cases);
  }
  catch (error) {
    console.error(`feature coverage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const selection = [featureId, ...parts, database, ...cases].filter(Boolean).join(' ');
  if (selection) console.log(`feature coverage: selected ${selection}`);
  const errors = await executeCoverage(selected, root);
  for (const error of errors) console.error(`feature coverage: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`feature coverage: ${selected.features.length} selected contracts executed`);
}
