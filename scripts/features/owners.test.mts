import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { caseTest } from '../../tests/testcase.mts';
import * as ownerSelection from './owners.mts';
import type { CheckInputs, Owner, TargetDeclaration } from './owners.mts';
import { parseJson, refusedPaths } from '../json/schema.mts';
import { readFeatures } from './manifest.mts';

const { CHECK_INPUTS_SCHEMA, checkInputErrors, makeArguments, manifestChanges, manifestInputErrors, pathScopeErrors, readCheckInputs, selectHelpers, selectOwners, selectTargets, untestedPaths } = ownerSelection;

const root = new URL('../..', import.meta.url).pathname;
const manifest = readFeatures(root);
const ids = (owners: Owner[]) => owners.map(owner => owner.feature.id);
// selected records the chosen verify commands and coverage units as `<feature>/<command>` and `<feature>/coverage/<part>`.
const selected = (owners: Owner[]) => owners.flatMap(({ feature, commands, parts }) => [
  ...commands.map(({ id }) => `${feature.id}/${id}`), ...parts.map(({ part }) => `${feature.id}/coverage/${part}`)]);
const helperIds = async (paths: string[]) => (await selectHelpers(manifest, root, paths)).map(({ helper }) => helper.id);

// Each case reads only repository files, so its deadline is 5 s.
caseTest('a changed test selects only the commands that run it', 5000, async () => {
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/go/orm/mysql_tls_test.go'])), ['dsn_connection/dsn-go', 'dsn_connection/dsn-mysql-tls-go']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/go/orm/external_documents_test.go'])), ['schema_install/install-register-go']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/php/tests/CoverageDsnTest.php'])), ['dsn_connection/coverage/owner/php']);
});

// An owner rule of config/owner-checks.json: its paths, and the make targets it selects when a path matches.
type OwnerRule = { paths: string[]; targets?: string[] };
function isOwnerRule(value: unknown): value is OwnerRule {
  return typeof value === 'object' && value !== null && 'paths' in value && Array.isArray(value.paths) && value.paths.every(glob => typeof glob === 'string');
}

// The owner rules of config/owner-checks.json select the lint target of each language (KSTD-5-47): a path of each language
// selects that language's lint target by its glob, so land runs the lint of a branch that changes the language.
caseTest('a changed path selects the lint target of its language', 5000, async () => {
  const text = await readFile(new URL('../../config/owner-checks.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(text);
  const rules = typeof parsed === 'object' && parsed !== null && 'owners' in parsed && Array.isArray(parsed.owners) ? parsed.owners.filter(isOwnerRule) : [];
  assert.ok(rules.length > 0, 'config/owner-checks.json has no owner rules');
  const targets = (path: string) => rules.filter(rule => rule.paths.some(glob => minimatch(path, glob))).flatMap(rule => rule.targets ?? []);
  const cases: [string, string][] = [
    ['packages/go/orm/errs.go', 'lint-go'],
    ['packages/rust/orm/src/errs.rs', 'lint-rust'],
    ['packages/python/orm/errs.py', 'lint-python'],
    ['packages/php/src/Errs.php', 'lint-php'],
    ['scripts/features/owners.mts', 'lint-ts'],
  ];
  for (const [path, lint] of cases)
    assert.ok(targets(path).includes(lint), `${path} selects ${targets(path).join(', ') || 'no target'}, not ${lint}`);
});

// The transaction-end case (G5.45-1) checks that for a file containing a test, the file selects the command that runs that test. Rust's tx.rs has its own
// tests module and tx_send_tests.rs, and Go's transaction_end_test.go, context_reset_test.go,
// cancelled_session_test.go tests cleanup at transaction end. failing_driver_test.go, which that test uses, is a helper, so it selects only its own
// check (go-test-helpers).
caseTest('a changed file selects the transaction end tests that it holds or that test it', 5000, async () => {
  for (const path of ['packages/rust/orm/src/tx.rs', 'packages/rust/orm/src/tx_send_tests.rs'])
    assert.deepEqual(selected(await selectOwners(manifest, root, [path])).filter(id => id.startsWith('transactions/')), ['transactions/transaction-end-rust'], path);
  for (const path of ['packages/go/orm/transaction_end_test.go', 'packages/go/orm/context_reset_test.go', 'packages/go/orm/cancelled_session_test.go'])
    assert.deepEqual(selected(await selectOwners(manifest, root, [path])), ['transactions/transaction-end-go'], path);
});

caseTest('a whole-suite command is split by package', 5000, async () => {
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/go/engine/ir/operators_test.go'])), ['planner/planner-go-ir']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/php/tests/DbspecRenderTest.php'])), ['schema_definition/schema-php']);
});

caseTest('a shared helper selects its own check and no feature', 5000, async () => {
  const helped: [string, string][] = [
    ['packages/php/tests/coverage_cases.php', 'coverage-runner-php'],
    ['packages/ts/tests/coverage_case.mjs', 'coverage-runner-typescript'],
    ['packages/php/tests/autoload.php', 'php-test-autoload'],
    ['packages/go/orm/test_helpers_test.go', 'go-test-helpers'],
    ['packages/rust/tests/tests/integration/coverage_env.rs', 'rust-test-helpers'],
  ];
  for (const [path, helper] of helped) {
    assert.deepEqual(await selectOwners(manifest, root, [path]), [], path);
    assert.deepEqual(await helperIds([path]), [helper], path);
  }
  assert.deepEqual(await helperIds(['packages/go/orm/mysql_tls_test.go']), []);
});

caseTest('a fixture selects the units whose declared data names it', 5000, async () => {
  // The coverage of schema_definition renders audit.dbs from contracts/fixtures/schema_definition.json.
  const owners = await selectOwners(manifest, root, ['contracts/fixtures/audit.dbs']);
  assert.deepEqual(ids(owners), ['schema_definition', 'audit_triggers']);
  const [first] = owners;
  assert.ok(first);
  assert.deepEqual(first.parts[0]?.reasons, ['contracts/fixtures/audit.dbs (named by contracts/fixtures/schema_definition.json)']);
  // contracts/symbols/rust.json records the symbols of the Rust source, so that source selects the Rust coverage unit, and that file
  // also selects the command of the test it contains (transaction-end-rust).
  assert.deepEqual(selected(await selectOwners(manifest, root, ['packages/rust/orm/src/tx_send_tests.rs'])), ['transactions/transaction-end-rust', 'interface_contract/coverage/owner/rust']);
});

caseTest('a path that no unit declares selects nothing', 5000, async () => {
  assert.deepEqual(await selectOwners(manifest, root, ['README.md', 'docs/plans/execution/checklist.md']), []);
  assert.deepEqual(await helperIds(['README.md']), []);
});

caseTest('a command without inputs or a helper used as an input fails the declaration', 5000, async () => {
  const tracked = ['a_test.go', 'helper.php', 'b.php', 'fixture.json'];
  const declared = {
    features: [{ id: 'f', verification: [{ id: 'none', command: 'x' }, { id: 'uses', command: 'y', inputs: ['b.php', 'helper.php'] }, { id: 'missing', command: 'z', inputs: ['gone/**'] }],
      coverage: { owners: { go: { tests: ['a_test.go'], inputs: ['fixture.json'] } } } }],
    helpers: [{ id: 'h', paths: ['helper.php'], tests: [], command: 'php helper_test.php' }, { id: 'h', paths: [], command: '' }],
  };
  assert.deepEqual(manifestInputErrors(declared, tracked), [
    'contracts/features.json f/none declares no inputs; declare the files whose change runs it',
    'contracts/features.json f/missing: input gone/** matches no tracked file',
    'contracts/features.json f/uses declares helper.php of contracts/features.json helper h as an input; a helper runs only its own check',
    'contracts/features.json helper h: duplicate or missing id',
    'contracts/features.json helper h: missing command',
    'contracts/features.json helper h: declares no paths',
    'contracts/features.json helper h: declares no tests list',
  ]);
  const files = (await import('node:child_process')).execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(manifestInputErrors(manifest, files), []);
});

// The make target case selects with the declaration in contracts/check-inputs.json and a minimal declaration.
const inputs = readCheckInputs(root).targets;
const targets = (selected: { target: string }[]) => selected.map(item => item.target);

caseTest('a changed document selects the documentation checks', 5000, async () => {
  const selected = targets(selectTargets(inputs, ['docs/plans/execution/checklist.md']));
  for (const target of ['docs-check', 'docs-rules-check', 'docs-verify-idempotent'])
    assert.ok(selected.includes(target), `selected ${selected.join(', ')}`);
  assert.ok(!selected.includes('rust-check'), `selected ${selected.join(', ')}`);
});

caseTest('a declared pattern matches by path segment', 5000, async () => {
  const owner = (inputs: string[]): TargetDeclaration => ({ scope: 'owner', needs: [], inputs });
  const declared = { one: owner(['docs/*.md']), deep: owner(['docs/**']), rust: owner(['packages/rust/**/*.rs']), any: owner(['**']) };
  assert.deepEqual(targets(selectTargets(declared, ['docs/a/b.md'])), ['deep', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['docs/a.md'])), ['one', 'deep', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['packages/rust/orm/src/lib.rs'])), ['rust', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['packages/rust/Cargo.toml'])), ['any']);
});

caseTest('every target of CHECK_TARGETS declares inputs that match tracked files', 5000, async () => {
  const makefile = await readFile(new URL('Makefile', `file://${root}`), 'utf8');
  const declaredTargets = /^CHECK_TARGETS = (.*)$/m.exec(makefile)?.[1];
  assert.ok(declaredTargets, 'the Makefile declares CHECK_TARGETS');
  const checkTargets = declaredTargets.trim().split(/\s+/);
  assert.ok(checkTargets.includes('group-rows-db-php-extension'), 'CHECK_TARGETS keeps the PHP extension database target');
  const tracked = (await import('node:child_process')).execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(checkInputErrors(inputs, checkTargets, tracked), []);
  assert.deepEqual(checkInputErrors({ a: { scope: 'owner', needs: [], inputs: ['docs/**'] }, b: { scope: 'owner', needs: [], inputs: ['nothing/**'] } }, ['a', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no scope of c of CHECK_TARGETS',
    'contracts/check-inputs.json declares b, which is not in CHECK_TARGETS',
    'contracts/check-inputs.json: b input nothing/** matches no tracked file',
  ]);
});

// The selected target receives owner-check's server and decimal environment, but not the Rust target directory: each checkout builds into its own
// target directory (AGENTS.md).
caseTest('a selected make target runs with the environments of owner-check and the target directory of its checkout', 5000, async () => {
  assert.deepEqual(makeArguments('docs-check', {}), ['--no-print-directory', '-k', 'docs-check']);
  assert.deepEqual(makeArguments('client-db-check', { ORM_TEST_ENV: '/main/.runtime/servers/env', DECIMAL_ENV: '/main/.runtime/decimal-env', CARGO_TARGET_DIR: '/main/cargo-target' }),
    ['--no-print-directory', '-k', 'TEST_ENV=/main/.runtime/servers/env', 'DECIMAL_ENV=/main/.runtime/decimal-env', 'client-db-check']);
});

// T42 was a change across four clients. A change of that shape selects only the changed features' checks and the file-level owner target,
// and the full suite target (scope suite) is run only by make orm-check.
const t42 = [
  'packages/go/orm/statement_events_test.go', 'packages/go/orm/events.go',
  'packages/php/src/StatementEvent.php', 'packages/php/tests/StatementEventsTest.php',
  'packages/rust/orm/src/events.rs', 'packages/rust/orm/tests/statement_events.rs',
  'packages/ts/src/events.ts', 'packages/ts/tests/statement-events.mjs',
  'contracts/fixtures/statement_events.dbs',
];

caseTest('a change across the four clients selects no full-suite target', 5000, async () => {
  // comment-language-check reads every source file (T131), so a source change selects it.
  assert.deepEqual(targets(selectTargets(inputs, t42)), ['comment-language-check', 'repo-check', 'go-fmt-check', 'go-vet-check', 'rust-fmt-check']);
  for (const target of ['client-db-check', 'client-pooler-check', 'case-database-check', 'conformance-check', 'feature-coverage', 'feature-verify-rust', 'feature-verify-other', 'go-test-check'])
    assert.equal(inputs[target]?.scope, 'suite', `${target} is not a full-suite target`);
  // The sources recorded by contracts/interfaces.json and contracts/symbols/*.json are inputs to the interface check.
  const owners = await selectOwners(manifest, root, t42);
  assert.deepEqual(ids(owners), ['statement_events', 'interface_contract']);
  assert.deepEqual(selected(owners.slice(0, 1)), [
    'statement_events/statement-events-go', 'statement_events/statement-events-typescript', 'statement_events/statement-events-php', 'statement_events/statement-events-rust',
    'statement_events/statement-events-python',
    'statement_events/coverage/owner/go', 'statement_events/coverage/owner/php', 'statement_events/coverage/owner/php-extension', 'statement_events/coverage/owner/rust', 'statement_events/coverage/owner/typescript',
    'statement_events/coverage/owner/python',
  ]);
});

// The schema case checks that the schema (scripts/check/schema/check-inputs.schema.json) accepts and rejects the shape of contracts/check-inputs.json:
// scope is owner or suite and declares needs, an owner target declares one or more inputs or lints,
// a suite target declares neither, and a path declaration gives a scope lint or suite and a non-empty reason for a path that is not a pattern.
const declarationsOf = (targets: unknown, paths: unknown = {}) => JSON.stringify({ comment: '', targets, paths });
const refused = (text: string): string[] => refusedPaths(() => parseJson<CheckInputs>(text, CHECK_INPUTS_SCHEMA, 'contracts/check-inputs.json'));

caseTest('the schema of contracts/check-inputs.json accepts the declared shapes', 5000, () => {
  assert.deepEqual(refused(declarationsOf({ a: { scope: 'owner', needs: [], inputs: ['docs/**'] }, b: { scope: 'owner', needs: ['go'], lints: ['**/*.go'] }, c: { scope: 'suite', needs: [] } },
    { 'b/LICENSE': { scope: 'lint', reason: 'license text' } })), []);
  assert.deepEqual(targets(selectTargets({ a: { scope: 'suite', needs: [] }, b: { scope: 'owner', needs: [], inputs: ['docs/**'] } }, ['docs/x.md'])), ['b']);
});

caseTest('the schema of contracts/check-inputs.json refuses a target or path outside its shape', 5000, () => {
  for (const [target, at] of [
    [{ needs: [], inputs: ['docs/**'] }, '/targets/a'],
    [['docs/**'], '/targets/a'],
    [{ scope: 'suite', needs: [], inputs: ['docs/**'] }, '/targets/a'],
    [{ scope: 'suite', needs: [], lints: ['**'] }, '/targets/a'],
    [{ scope: 'owner', needs: [] }, '/targets/a'],
    [{ scope: 'owner', needs: [], inputs: [] }, '/targets/a'],
    [{ scope: 'owner', inputs: ['docs/**'] }, '/targets/a'],
  ] as const)
    assert.ok(refused(declarationsOf({ a: target })).includes(at), JSON.stringify(target));
  assert.ok(refused(declarationsOf({}, { 'a/*.go': { scope: 'suite', reason: 'r' } })).includes('/paths'));
  assert.ok(refused(declarationsOf({}, { 'b/LICENSE': { scope: 'any', reason: 'r' } })).includes('/paths/b~1LICENSE/scope'));
  assert.ok(refused(declarationsOf({}, { 'b/LICENSE': { scope: 'lint', reason: ' ' } })).includes('/paths/b~1LICENSE/reason'));
  assert.ok(refused(declarationsOf({}, { 'b/LICENSE': { scope: 'lint' } })).includes('/paths/b~1LICENSE'));
  assert.ok(refused(JSON.stringify({ comment: '', targets: {} })).includes('/'));
});

// The needs case (G5.38-1, G5.52) checks setup-step declarations: every target declares needs, and the values are what the setup step
// provides (scripts/check/ci-setup.mts).
caseTest('every target declares the setup steps it needs', 5000, async () => {
  assert.deepEqual(checkInputErrors({ b: { scope: 'suite', needs: ['servers'] }, c: { scope: 'suite', needs: ['databases'] } }, ['b', 'c'], []), [
    'contracts/check-inputs.json: b needs servers, which no setup step provides; the needs are databases, go, node-modules, rust, php-min, php, composer, php-extension-tools, server-programs, python, flowmark',
  ]);
});

caseTest('a changed feature entry of contracts/features.json selects that feature only', 5000, async () => {
  const feature = (id: string, n: number) => ({ id, n, verification: [{ id: 'c', command: 'x', inputs: ['x.php'] }] });
  const before = { manifest_version: 1, features: [feature('one', 1), feature('two', 1)] };
  const after = { manifest_version: 1, features: [feature('one', 2), feature('two', 1), feature('three', 1)] };
  assert.deepEqual(manifestChanges(before, after), { features: ['one', 'three'], helpers: [], whole: false });
  assert.deepEqual(manifestChanges(before, { ...after, manifest_version: 2 }), { features: ['one', 'three'], helpers: [], whole: true });
  assert.deepEqual(manifestChanges(before, { ...before, features: before.features.slice(1) }), { features: [], helpers: [], whole: true });
  assert.deepEqual(manifestChanges(null, after), { features: ['one', 'two', 'three'], helpers: [], whole: true });
  const owners = await selectOwners(after, root, ['contracts/features.json'], manifestChanges(before, after));
  assert.deepEqual(owners.map(owner => owner.feature.id), ['one', 'three']);
  assert.deepEqual(owners[0]?.commands, [{ id: 'c', reasons: ['contracts/features.json (entry of one)'] }]);
  const helped = { ...after, helpers: [{ id: 'h', paths: ['x.php'], tests: [], command: 'php x' }] };
  assert.deepEqual(manifestChanges(after, helped), { features: [], helpers: ['h'], whole: false });
  assert.deepEqual((await selectHelpers(helped, root, ['contracts/features.json'], manifestChanges(after, helped))).map(({ helper, reasons }) => [helper.id, reasons]),
    [['h', ['contracts/features.json (entry of h)']]]);
});

// The executed-database case checks how owner-check picks the target that builds its bench and decimal databases, and how it
// reads the database's environment file.
caseTest('owner-check creates the databases of its run for a target that reads the server environment', 5000, () => {
  const { environmentFile, usesTestEnv } = ownerSelection;
  const makefile = 'WITH_TEST_ENV = x\nuses:\n\t$(WITH_TEST_ENV) go test ./a\n\nplain:\n\tnode --test a.test.mjs\n';
  assert.equal(usesTestEnv(makefile, 'uses'), true);
  assert.equal(usesTestEnv(makefile, 'plain'), false);
  assert.equal(usesTestEnv(makefile, 'absent'), false);
  // A target whose name holds a slash, such as testcase-check/go, is looked up like any other (T137-1-4-2-2).
  assert.equal(usesTestEnv(`${makefile}part/db:\n\t$(WITH_TEST_ENV) go test ./b\n`, 'part/db'), true);
  assert.deepEqual(environmentFile("export BENCH_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_owner_1_ab_bench?timezone=%2B00:00'\n\nexport A='b c'\n"),
    { BENCH_MYSQL_DSN: 'mysql://root@127.0.0.1:1/orm_owner_1_ab_bench?timezone=%2B00:00', A: 'b c' });
  assert.throws(() => environmentFile('A=b\n'), /unexpected environment line: A=b/);
});

// The behavior-test case (G5.51) checks that owner-check selects the behavior test for each changed path. It does so not with inputs but with
// a path matched only by lints (go vet, gofmt, document rules) is not tested; a path with a scope declared in paths passes
// with that declaration.
caseTest('a path that only a lint selects is untested unless its scope is declared', 5000, () => {
  const declared: Record<string, TargetDeclaration> = { lint: { scope: 'owner', needs: [], lints: ['**/*.go'] }, unit: { scope: 'owner', needs: [], inputs: ['a/*_test.go'], lints: ['**/*.go'] } };
  const targets = selectTargets(declared, ['a/x.go', 'a/x_test.go', 'b/LICENSE']);
  assert.deepEqual(targets.map(({ target, tested }) => [target, tested]), [['lint', []], ['unit', ['a/x_test.go']]]);
  const empty = { owners: [], helpers: [], targets, exists: () => true };
  assert.deepEqual(untestedPaths(['a/x.go', 'a/x_test.go', 'b/LICENSE'], { ...empty, paths: {} }), ['a/x.go', 'b/LICENSE']);
  assert.deepEqual(untestedPaths(['a/x.go', 'b/LICENSE'], { ...empty, paths: { 'b/LICENSE': { scope: 'lint', reason: 'license text' } } }), ['a/x.go']);
  assert.deepEqual(untestedPaths(['gone.go'], { ...empty, paths: {}, exists: () => false }), []);
  assert.deepEqual(pathScopeErrors({ 'b/LICENSE': { scope: 'lint', reason: 'r' }, 'c/x': { scope: 'lint', reason: 'r' } }, ['b/LICENSE']), [
    'contracts/check-inputs.json paths: c/x is not a tracked file',
  ]);
});

caseTest('a generator source selects the check that regenerates the models', 5000, () => {
  const { targets: declared } = readCheckInputs(root);
  const selected = selectTargets(declared, ['packages/go/generator/gen_go.go']).filter(({ tested }) => tested.length).map(({ target }) => target);
  assert.deepEqual(selected, ['comment-language-check', 'go-model-check', 'generated-lint-check']);
});

// The bootstrap tsconfig that the TypeScript build reads before the models exist is tracked, so it must declare its scope (KSTD-5-5-1).
caseTest('the bootstrap tsconfig of the TypeScript build declares its scope', 5000, () => {
  const { paths } = readCheckInputs(root);
  assert.equal(paths['packages/ts/tsconfig.bootstrap.json']?.scope, 'suite');
});

// The whole-tree case checks that each tracked file has a behavior test or a scope declaration. If any lacks one, it names that file and fails.
caseTest('every tracked file selects a behaviour test or declares its scope', 30000, async () => {
  const declarations = readCheckInputs(root);
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const owners = await selectOwners(manifest, root, tracked);
  const helpers = await selectHelpers(manifest, root, tracked);
  const targets = selectTargets(declarations.targets, tracked);
  assert.deepEqual(untestedPaths(tracked, { owners, helpers, targets, paths: declarations.paths, exists: () => true }), []);
  assert.deepEqual(pathScopeErrors(declarations.paths, tracked), []);
});
