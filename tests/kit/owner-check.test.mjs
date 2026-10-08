// Tests of scripts/kit/owner-check.mjs: the validation of the declaration, the selection of the owners of changed paths
// and the command that runs them. Each rule has a passing and a failing case.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandsOf, makefileText, npmProject, select, suiteTargets, validate } from '../../scripts/kit/owner-check.mjs';
import { trackedFiles } from '../../scripts/kit/tracked-files.mjs';
import { put, tree } from './tree.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit');
const MAKEFILE = `CHECK_TARGETS := docs-check unit-test lint
include extra.mk

docs-check:
\t@echo docs
unit-test: build
\t@echo unit
build:
\t@echo build
lint:
\t@echo lint
check:
\tnode scripts/kit/full-run.mjs
`;
const FILES = {
  Makefile: MAKEFILE,
  'extra.mk': 'extra-check:\n\t@echo extra\n',
  'README.md': '# readme\n',
  'src/a.js': '1\n',
  'tests/a.test.mjs': '1\n',
  'package.json': JSON.stringify({ scripts: { 'test:forms': 'x' }, workspaces: ['packages/*'] }),
  'packages/one/package.json': JSON.stringify({ name: '@x/one', scripts: { test: 'x' } }),
  'tools/bench/package.json': JSON.stringify({ name: 'bench', scripts: { test: 'x' } }),
  'packages/none/package.json': JSON.stringify({ name: '@x/none' }),
};
const DECLARATION = {
  schema: 1,
  always: ['tests/a.test.mjs'],
  owners: [
    { paths: ['*.md'], targets: ['docs-check'] },
    { paths: ['src/**'], targets: ['unit-test', 'extra-check'], scripts: ['test:forms'], tests: ['tests/a.test.mjs'] },
    { paths: ['tests/*.test.mjs'], tests: ['$path'] },
    { paths: ['Makefile', 'extra.mk', 'package.json'], targets: ['lint'] },
    { paths: ['packages/one/**'], workspaces: ['@x/one'] },
    { paths: ['packages/none/**'], targets: ['lint'] },
    { paths: ['tools/bench/**'], prefixes: ['tools/bench'] },
  ],
};

function project(t, files = FILES) {
  const root = tree(t, files);
  const tracked = trackedFiles(root);
  return { root, tracked, project: { makefile: makefileText(root), ...npmProject(root, tracked) } };
}
const errorsOf = (t, declaration, files) => {
  const { tracked, project: found } = project(t, files);
  return validate(declaration, tracked, found, file => tracked.includes(file));
};
const has = (errors, ...parts) => assert.ok(errors.some(line => parts.every(part => line.includes(part))), `expected ${parts.join(' ... ')}\nin\n${errors.join('\n')}`);

test('a declaration that owns every path passes, with targets of an included file and the npm project', (t) => {
  const { tracked, project: found } = project(t);
  assert.deepEqual(found.workspaces, ['@x/one']);
  assert.deepEqual(found.prefixes, ['tools/bench']);
  assert.deepEqual(Object.keys(found.scripts), ['test:forms']);
  assert.deepEqual(validate(DECLARATION, tracked, found, file => tracked.includes(file)), []);
  assert.deepEqual(suiteTargets(found.makefile), ['docs-check', 'unit-test', 'lint']);
});

test('a tracked path without an owner and a glob without a path fail', (t) => {
  const declaration = { ...DECLARATION, owners: [DECLARATION.owners[1], { paths: ['gone/**'], targets: ['lint'] }] };
  const errors = errorsOf(t, declaration);
  has(errors, 'README.md', 'matches no owner in config/owner-checks.json', 'add a rule');
  has(errors, 'the glob gone/** matches no tracked path');
});

test('a target that is not in the Makefile and a target that runs the full suite fail', (t) => {
  const missing = errorsOf(t, { ...DECLARATION, owners: [...DECLARATION.owners, { paths: ['src/**'], targets: ['nope'] }] });
  has(missing, 'the target nope of src/** is not a target of the Makefile');
  const full = errorsOf(t, { ...DECLARATION, owners: [...DECLARATION.owners, { paths: ['src/**'], targets: ['check'] }] });
  has(full, 'the target check of src/** runs the full suite');
  const named = errorsOf(t, { ...DECLARATION, fullSuite: ['lint'] });
  has(named, 'the target lint', 'runs the full suite');
  has(errorsOf(t, { ...DECLARATION, fullSuite: ['absent'] }), 'fullSuite names absent');
});

test('a rule that selects every target of CHECK_TARGETS fails', (t) => {
  const errors = errorsOf(t, { ...DECLARATION, owners: [...DECLARATION.owners, { paths: ['src/**'], targets: ['docs-check', 'unit-test', 'lint'] }] });
  has(errors, 'a rule selects every target of CHECK_TARGETS');
});

test('a script, workspace, directory, test file or test target that does not exist fails', (t) => {
  const errors = errorsOf(t, {
    ...DECLARATION,
    always: ['tests/absent.mjs'],
    testTarget: 'absent-target',
    owners: [...DECLARATION.owners, { paths: ['src/**'], scripts: ['absent'], workspaces: ['@x/none'], prefixes: ['packages/none'], tests: ['tests/missing.test.mjs'] }, { paths: ['src/**'], variable: 'CASES' }],
  });
  has(errors, 'the script absent of src/** is not a script of package.json');
  has(errors, 'the workspace @x/none of src/** is not a workspace with a test script');
  has(errors, 'the directory packages/none of src/** is not a package directory with a test script');
  has(errors, 'the test tests/missing.test.mjs of src/** does not exist');
  has(errors, 'the test tests/absent.mjs of always does not exist');
  has(errors, 'testTarget absent-target is not a target');
  has(errors, 'sets the variable CASES but selects no target');
});

test('inputs: a path that a check reads needs a rule that selects the check or a target that runs it', (t) => {
  const inputs = (check, paths) => ({ ...DECLARATION, inputs: [{ check, paths }] });
  assert.deepEqual(errorsOf(t, inputs('make build', ['src/a.js'])), [], 'unit-test has the prerequisite build');
  assert.deepEqual(errorsOf(t, inputs('npm run test:forms', ['src/a.js'])), []);
  has(errorsOf(t, inputs('make lint', ['src/a.js'])), 'src/a.js: an input of make lint, which no owner rule of the path selects');
  has(errorsOf(t, inputs('make absent', ['src/a.js'])), 'inputs of "make absent" name no make target');
  has(errorsOf(t, inputs('make lint', ['nothing/**'])), 'the input glob nothing/** of make lint matches no tracked path');
});

test('select: a changed path selects its owners; always, $path, variables and the suite order apply', () => {
  const declaration = {
    always: ['tests/always.test.mjs'],
    owners: [
      { paths: ['src/**'], targets: ['lint'], variable: 'CASES' },
      { paths: ['src/**'], targets: ['docs-check'], scripts: ['s'] },
      { paths: ['tests/*.test.mjs'], tests: ['$path'] },
    ],
  };
  const result = select(declaration, ['src/a.js', 'src/b.js', 'tests/x.test.mjs'], ['docs-check', 'lint'], () => true);
  assert.deepEqual(result.checks.map(check => check.name), ['make docs-check', 'make lint CASES=src/a.js src/b.js', 'npm run s']);
  assert.deepEqual(result.checks[1].args, ['--no-print-directory', 'lint', 'CASES=src/a.js src/b.js']);
  assert.deepEqual(result.tests, ['tests/always.test.mjs', 'tests/x.test.mjs']);
  assert.deepEqual(result.unowned, []);
  assert.ok(result.reasons.includes('tests/x.test.mjs -> tests/x.test.mjs'));
});

test('select: a removed path that no rule owns selects nothing, an existing one is unowned, a removed test does not run', () => {
  const declaration = { owners: [{ paths: ['tests/*.test.mjs'], tests: ['$path'] }] };
  const result = select(declaration, ['gone.txt', 'here.txt', 'tests/gone.test.mjs'], [], file => file === 'here.txt');
  assert.deepEqual(result.unowned, ['here.txt']);
  assert.deepEqual(result.tests, []);
  assert.ok(result.reasons.includes('gone.txt -> nothing: the path was removed and no rule owns it'));
});

test('the tests run through run-tests.mjs or through the declared test target', () => {
  const selection = { checks: [], tests: ['tests/a.test.mjs', 'tests/b.test.mjs'] };
  const direct = commandsOf(selection, {});
  assert.deepEqual(direct.map(command => command.args), [['scripts/kit/run-tests.mjs', 'node', '--', 'tests/a.test.mjs', 'tests/b.test.mjs']]);
  const target = commandsOf(selection, { testTarget: 'test-scripts' });
  assert.deepEqual(target[0].args, ['--no-print-directory', 'test-scripts', 'TESTS=tests/a.test.mjs tests/b.test.mjs']);
  assert.deepEqual(commandsOf({ checks: [], tests: [] }, {}), []);
});

function command(root, args) {
  return spawnSync(process.execPath, ['scripts/kit/owner-check.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

function checkout(t, declaration = DECLARATION, files = {}) {
  const root = tree(t, { ...FILES, ...files, 'config/owner-checks.json': JSON.stringify(declaration) });
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  return root;
}
const full = { ...DECLARATION, owners: [...DECLARATION.owners, { paths: ['config/**', 'scripts/kit/**'], targets: ['lint'] }] };

test('the command validates the declaration and names each error', (t) => {
  const root = checkout(t, DECLARATION);
  const failed = command(root, ['--validate']);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /\[owner-check\] scripts\/kit\/owner-check\.mjs: the path matches no owner in config\/owner-checks\.json; add a rule/);
  const passed = command(checkout(t, full), ['--validate']);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /owns every tracked path/);
});

test('the command prints the selection of --dry-run and fails for an unowned path', (t) => {
  const root = checkout(t, full);
  const dry = command(root, ['--paths', 'README.md src/a.js', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /2 changed paths select make docs-check; make unit-test; make extra-check; npm run test:forms; node tests tests\/a\.test\.mjs/);
  put(root, { 'new.bin': 'x' });
  const unowned = command(root, ['--paths', 'new.bin', '--dry-run']);
  assert.equal(unowned.status, 1, unowned.stdout + unowned.stderr);
});

test('the command runs every selected check, also after one failed, and lists the failures', (t) => {
  const makefile = 'CHECK_TARGETS := first second third\nfirst:\n\t@echo ran-first\nsecond:\n\t@echo ran-second; exit 3\nthird:\n\t@echo ran-third\n';
  const root = tree(t, { Makefile: makefile, 'a.txt': 'x', 'config/owner-checks.json': JSON.stringify({ schema: 1, owners: [{ paths: ['a.txt'], targets: ['first', 'second'] }, { paths: ['Makefile', 'config/**', 'scripts/kit/**'], targets: ['third'] }] }) });
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  const run = command(root, ['--paths', 'a.txt']);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /ran-first/);
  assert.match(run.stdout, /ran-second/);
  assert.match(run.stdout, /\[owner-check\] make first passed in [\d.]+ s/);
  assert.match(run.stdout, /\[owner-check\] make second failed with 2 in [\d.]+ s/);
  assert.match(run.stdout, /\[owner-check\] failed: make second/);
  const ok = command(root, ['--paths', 'Makefile']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /every owner check passed/);
});

test('the command fails with the fix when the declaration is missing', (t) => {
  const root = tree(t, { 'a.txt': 'x' });
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  const run = command(root, ['--validate']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /config\/owner-checks\.json does not exist; declare the owner of each path there/);
});
