// offline-tests names the tests of make test-rust and make test-python, the two targets that run without the test servers
// and without flowmark (T570, T580). A test that reads a database server or the flowmark server fails without it, and no
// test skips itself, so the offline targets select by name the tests whose name says that they need neither, and the
// targets with the servers and with flowmark run the others: client-db-rust-check runs the whole Rust workspace with both
// and leaves the markdown conformance cases to markdown-conformance-check/rust and the measurements to
// feature-performance-check (scripts/client-db-test.mts); suite-python-check runs every Python test file with both.
//
// What a name says:
//   rust    the test program all of packages/rust/programs names a test <group>::<name>, and the groups are the modules that
//           tests/all/main.rs lists. A group <recipe>_mysql or <recipe>_postgres runs on that server and a group
//           <recipe>_markdown on flowmark (docs/spec/feature-coverage.md FCV-3). A test of another group whose own name
//           ends in _mysql or _postgres runs on that server, and one that ends in _servers on more than one server. The tests that client-db-test.mts leaves to another target
//           are left here too. Every other test, and every test of another program of the workspace, is offline.
//   python  a test module test_<recipe>_mysql.py or test_<recipe>_postgres.py runs on that server and
//           test_<recipe>_markdown.py on flowmark. A test of another module whose method ends in _mysql, _postgres
//           or _servers runs on that server or on more than one. Every other test is offline. A case of a recipe is named by its case id alone, so unittest
//           selects it by its module.
// A test that reads a server and whose name does not say so stays in the offline selection and fails there with its own
// message: nothing is skipped by a list, and the fix is at the test, whose name or group says what it runs on.
//
// It prints the argument of the test runner, and on the standard error the number of tests that it left to the other targets:
//   rust <listing>    the --skip arguments of the left tests, read from the listing that cargo test -- --list printed
//   python <python>   the names of the offline modules and tests, which the unittest of the Python of the venv lists
// A selection of no test is an error, so a run never passes on a selection of nothing.
//
// Usage: node scripts/repo/offline-tests.mts rust <listing file> | python <python of the venv>
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUST_MAIN = 'packages/rust/programs/tests/all/main.rs';
const PYTHON_TESTS = 'legacy/packages/python/tests';

export const NEEDS = ['mysql', 'postgres', 'servers', 'flowmark', 'elsewhere'] as const;
export type Need = (typeof NEEDS)[number];
export type Counts = Record<Need, number>;
// The end of a name: _mysql and _postgres for one server, _servers for more than one, _markdown for flowmark.
const NEED_OF_SUFFIX: Record<string, Need> = { mysql: 'mysql', postgres: 'postgres', servers: 'servers', markdown: 'flowmark' };
const zero = (): Counts => ({ mysql: 0, postgres: 0, servers: 0, flowmark: 0, elsewhere: 0 });

/** rustGroups are the groups of the test program all, read from the text of its main.rs. */
export function rustGroups(main: string): string[] {
  const groups = [...main.matchAll(/\bGroup::(?:new|recipe)\("([a-z0-9_]+)"/g)].map(match => match[1] ?? '');
  if (groups.length === 0) throw new Error(`${RUST_MAIN} lists no group (Group::new or Group::recipe); read rustGroups of scripts/repo/offline-tests.mts against it`);
  return groups;
}

/** listedTests are the names of the tests of a listing of cargo test -- --list, the lines `<name>: test`. */
export function listedTests(listing: string): string[] {
  return listing.split('\n').flatMap(line => { const name = /^(.+): test$/.exec(line)?.[1]; return name === undefined ? [] : [name]; });
}

/** rustNeed is what the test `name` runs on by its name, or undefined for a test that the offline run selects. */
export function rustNeed(name: string, groups: ReadonlySet<string>, elsewhere: ReadonlySet<string>): Need | undefined {
  if (elsewhere.has(name)) return 'elsewhere';
  const [group = '', ...rest] = name.split('::');
  if (rest.length === 0 || !groups.has(group)) return undefined;
  const suffix = (text: string, suffixes: string): string | undefined => new RegExp(`_(${suffixes})$`).exec(text)?.[1];
  const ofGroup = suffix(group, 'mysql|postgres|servers|markdown');
  if (ofGroup !== undefined) return NEED_OF_SUFFIX[ofGroup];
  const ofTest = suffix(rest.at(-1) ?? '', 'mysql|postgres|servers');
  return ofTest === undefined ? undefined : NEED_OF_SUFFIX[ofTest];
}

/**
 * rustSelection is the --skip patterns of the tests of `names` that the offline run leaves out, with their number by what
 * they run on. A pattern is `<group>::` for a group that is left whole and the name of the test otherwise. libtest leaves
 * out every test whose name contains a pattern, so a pattern that a selected test contains is an error.
 */
export function rustSelection(names: readonly string[], groups: ReadonlySet<string>, elsewhere: ReadonlySet<string>): { skips: string[]; left: Counts; selected: number } {
  const left = zero();
  const leftNames: string[] = [];
  const selected: string[] = [];
  for (const name of names) {
    const need = rustNeed(name, groups, elsewhere);
    if (need === undefined) selected.push(name);
    else { left[need]++; leftNames.push(name); }
  }
  if (selected.length === 0) throw new Error(`the offline selection of the Rust tests holds no test (${names.length} tests listed); the listing is the output of cargo test -- --list, whose lines are <name>: test`);
  const groupOf = (name: string): string => name.slice(0, name.indexOf('::'));
  const whole = new Set(leftNames.map(groupOf).filter(group => !selected.some(name => groupOf(name) === group && name.includes('::'))));
  const skips = [...new Set(leftNames.map(name => (whole.has(groupOf(name)) ? `${groupOf(name)}::` : name)))];
  for (const pattern of skips) {
    const caught = selected.find(name => name.includes(pattern));
    if (caught !== undefined) throw new Error(`--skip ${pattern} leaves out the offline test ${caught}, whose name contains it; give one of the two a name that the other does not contain`);
  }
  return { skips, left, selected: selected.length };
}

/** pythonNeed is what the test module `file` of the Python client runs on by its name, or undefined for an offline module. */
export function pythonNeed(file: string): Need | undefined {
  const suffix = /^test_\w+_(mysql|postgres|markdown)\.py$/.exec(file)?.[1];
  return suffix === undefined ? undefined : NEED_OF_SUFFIX[suffix];
}

const PYTHON_PACKAGE = PYTHON_TESTS.replaceAll('/', '.');

/**
 * pythonSelection is the names that unittest takes for the offline tests among the test modules `files`, and the number of
 * tests that are left by what they run on. `testsOf` gives the ids of the tests of a module, as unittest loads them. A
 * module that is left by its name is left whole. In another module, a test <module>.<class>.<method> whose method ends in
 * _mysql, _postgres or _servers is left; such a module is selected by the ids of its other tests, and a module without one by its name.
 */
export function pythonSelection(files: readonly string[], testsOf: (module: string) => readonly string[]): { names: string[]; left: Counts; selected: number } {
  const tests = files.filter(file => /^test_\w+\.py$/.test(file)).sort();
  const left = zero();
  const names: string[] = [];
  let selected = 0;
  for (const file of tests) {
    const module = `${PYTHON_PACKAGE}.${file.replace(/\.py$/, '')}`;
    const ids = testsOf(module);
    const ofModule = pythonNeed(file);
    if (ofModule !== undefined) { left[ofModule] += ids.length; continue; }
    const needOf = (id: string): Need | undefined => {
      const suffix = id.startsWith(`${module}.`) ? /_(mysql|postgres|servers)$/.exec(id)?.[1] : undefined;
      return suffix === undefined ? undefined : NEED_OF_SUFFIX[suffix];
    };
    const offline = ids.filter(id => needOf(id) === undefined);
    for (const id of ids) { const need = needOf(id); if (need !== undefined) left[need]++; }
    selected += offline.length;
    if (offline.length === ids.length) { names.push(module); continue; }
    // A case of a recipe is named by its case id alone, which unittest cannot select, so it shares no module with a left test.
    const unnamed = offline.find(id => !id.startsWith(`${module}.`));
    if (unnamed !== undefined) throw new Error(`the module ${module} holds a test of a server and the test ${unnamed}, which unittest cannot select by its id; move one of the two to a module of its own`);
    names.push(...offline);
  }
  if (selected === 0) throw new Error(`the offline selection of the Python tests holds no test (${tests.length} modules test_*.py in ${PYTHON_TESTS}); the tests of the client are its files test_*.py`);
  return { names, left, selected };
}

// The ids of the tests of each module, which unittest of the venv loads without running one: a line <module> <id> for each.
const LIST = [
  'import sys, unittest',
  'def tests(suite):',
  '    for item in suite:',
  '        if isinstance(item, unittest.TestSuite):',
  '            yield from tests(item)',
  '        else:',
  '            yield item',
  'for module in sys.argv[1:]:',
  '    for test in tests(unittest.defaultTestLoader.loadTestsFromName(module)):',
  '        if type(test).__module__ == "unittest.loader":',
  '            sys.exit(f"{module} does not load: {test}")',
  '        print(module, test.id())',
].join('\n');
function pythonTests(python: string, files: readonly string[]): Map<string, string[]> {
  const modules = files.filter(file => /^test_\w+\.py$/.test(file)).map(file => `${PYTHON_PACKAGE}.${file.replace(/\.py$/, '')}`);
  const result = spawnSync(python, ['-c', LIST, ...modules], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${python} did not list the tests of ${PYTHON_TESTS} (exit ${result.status ?? 'none'}): ${result.stderr.trim()}; run make orm-install-python, which builds the venv`);
  const listed = new Map<string, string[]>(modules.map(module => [module, []]));
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf(' ');
    if (at > 0) listed.get(line.slice(0, at))?.push(line.slice(at + 1));
  }
  return listed;
}

async function main(args: readonly string[]): Promise<number> {
  const [runtime, argument] = args;
  try {
    if (runtime === 'rust' && argument !== undefined && args.length === 2) {
      const names = listedTests(readFileSync(argument, 'utf8'));
      // client-db-test.mts reads the trees of every client when it is loaded, so it is loaded for this selection alone.
      const { rustOwnedElsewhereSkipArguments } = await import('../client-db-test.mts');
      const elsewhere = new Set(rustOwnedElsewhereSkipArguments(ROOT).filter(word => word !== '--skip'));
      const { skips, left, selected } = rustSelection(names, new Set(rustGroups(readFileSync(join(ROOT, RUST_MAIN), 'utf8'))), elsewhere);
      console.error(`offline-tests: make test-rust selects ${selected} of ${names.length} tests and leaves ${left.mysql} of MySQL, ${left.postgres} of PostgreSQL, ${left.servers} of several servers and ${left.flowmark} of flowmark to make client-db-rust-check, and ${left.elsewhere} to make markdown-conformance-check/rust and make feature-performance-check`);
      process.stdout.write(`${skips.flatMap(pattern => ['--skip', pattern]).join(' ')}\n`);
      return 0;
    }
    if (runtime === 'python' && argument !== undefined && args.length === 2) {
      const files = readdirSync(join(ROOT, PYTHON_TESTS));
      const listed = pythonTests(argument, files);
      const { names, left, selected } = pythonSelection(files, module => listed.get(module) ?? []);
      const total = [...listed.values()].reduce((sum, ids) => sum + ids.length, 0);
      console.error(`offline-tests: make test-python selects ${selected} of ${total} tests and leaves ${left.mysql} of MySQL, ${left.postgres} of PostgreSQL, ${left.servers} of several servers and ${left.flowmark} of flowmark to make suite-python-check`);
      process.stdout.write(`${names.join(' ')}\n`);
      return 0;
    }
  } catch (error) {
    console.error(`offline-tests: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.error('usage: offline-tests.mts rust <listing file> | python <python of the venv>; name the runtime, and for rust the file that holds the output of cargo test -- --list');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
