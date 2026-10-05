import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { caseTest } from '../../tests/testcase.mjs';
import * as ownerSelection from './owners.mjs';

const { checkInputErrors, makeArguments, manifestChanges, manifestInputErrors, pathScopeErrors, selectHelpers, selectOwners, selectTargets, untestedPaths } = ownerSelection;

const root = new URL('../..', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(new URL('contracts/features.json', `file://${root}`), 'utf8'));
const ids = owners => owners.map(owner => owner.feature.id);
// selected는 고른 검증 명령과 coverage 단위를 `<feature>/<command>`, `<feature>/coverage/<part>`로 적는다.
const selected = owners => owners.flatMap(({ feature, commands, parts }) => [
  ...commands.map(({ id }) => `${feature.id}/${id}`), ...parts.map(({ part }) => `${feature.id}/coverage/${part}`)]);
const helperIds = async paths => (await selectHelpers(manifest, root, paths)).map(({ helper }) => helper.id);

// 각 case는 repository file만 읽으므로 기한은 5 s다.
caseTest('a changed test selects only the commands that run it', 5000, async () => {
  assert.deepEqual(selected(await selectOwners(manifest, root, ['clients/go/orm/mysql_tls_test.go'])), ['dsn_connection/dsn-go', 'dsn_connection/dsn-mysql-tls-go']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['clients/go/orm/external_documents_test.go'])), ['schema_install/install-register-go']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['clients/php/tests/coverage_dsn.php'])), ['dsn_connection/coverage/owner/php']);
});

// transaction 끝 case(G5.45-1)는 test가 들어 있는 file이 그 test를 실행하는 명령을 고르는지 본다. Rust의 tx.rs는 자기
// tests module과 tx_send_tests.rs를 가지고, Go의 transaction_end_test.go, context_reset_test.go,
// cancelled_session_test.go는 transaction 끝의 정리를 test한다. 그 test가 쓰는 failing_driver_test.go는 helper이므로 자기
// 검사(go-test-helpers)만 고른다.
caseTest('a changed file selects the transaction end tests that it holds or that test it', 5000, async () => {
  for (const path of ['clients/rust/orm/src/tx.rs', 'clients/rust/orm/src/tx_send_tests.rs'])
    assert.deepEqual(selected(await selectOwners(manifest, root, [path])).filter(id => id.startsWith('transactions/')), ['transactions/transaction-end-rust'], path);
  for (const path of ['clients/go/orm/transaction_end_test.go', 'clients/go/orm/context_reset_test.go', 'clients/go/orm/cancelled_session_test.go'])
    assert.deepEqual(selected(await selectOwners(manifest, root, [path])), ['transactions/transaction-end-go'], path);
});

caseTest('a whole-suite command is split by package', 5000, async () => {
  assert.deepEqual(selected(await selectOwners(manifest, root, ['engine/ir/operators_test.go'])), ['planner/planner-go-ir']);
  assert.deepEqual(selected(await selectOwners(manifest, root, ['clients/php/tests/dbspec_render_test.php'])), ['schema_definition/schema-php']);
});

caseTest('a shared helper selects its own check and no feature', 5000, async () => {
  for (const [path, helper] of [
    ['clients/php/tests/coverage_cases.php', 'coverage-runner-php'],
    ['clients/typescript/tests/coverage_case.mjs', 'coverage-runner-typescript'],
    ['clients/php/tests/autoload.php', 'php-test-autoload'],
    ['clients/go/orm/test_helpers_test.go', 'go-test-helpers'],
    ['clients/rust/tests/src/coverage_env.rs', 'rust-test-helpers'],
  ]) {
    assert.deepEqual(await selectOwners(manifest, root, [path]), [], path);
    assert.deepEqual(await helperIds([path]), [helper], path);
  }
  assert.deepEqual(await helperIds(['clients/go/orm/mysql_tls_test.go']), []);
});

caseTest('a fixture selects the units whose declared data names it', 5000, async () => {
  // schema_definition의 coverage는 contracts/fixtures/schema_definition.json에서 audit.dbs를 렌더링한다.
  const owners = await selectOwners(manifest, root, ['contracts/fixtures/audit.dbs']);
  assert.deepEqual(ids(owners), ['schema_definition', 'audit_triggers']);
  assert.deepEqual(owners[0].parts[0].reasons, ['contracts/fixtures/audit.dbs (named by contracts/fixtures/schema_definition.json)']);
  // contracts/symbols/rust.json은 Rust source의 symbol을 적으므로 그 source는 Rust coverage 단위를 고르고, 그 file이
  // 담은 test의 명령(transaction-end-rust)도 고른다.
  assert.deepEqual(selected(await selectOwners(manifest, root, ['clients/rust/orm/src/tx_send_tests.rs'])), ['transactions/transaction-end-rust', 'interface_contract/coverage/owner/rust']);
});

caseTest('a path that no unit declares selects nothing', 5000, async () => {
  assert.deepEqual(await selectOwners(manifest, root, ['README.md', 'docs/checklist.md']), []);
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

// make target case는 contracts/check-inputs.json의 선언과 최소 선언으로 고른다.
const inputs = JSON.parse(await readFile(new URL('contracts/check-inputs.json', `file://${root}`), 'utf8')).targets;
const targets = selected => selected.map(item => item.target);

caseTest('a changed document selects the documentation checks', 5000, async () => {
  const selected = targets(selectTargets(inputs, ['docs/checklist.md']));
  for (const target of ['checklist-check', 'docs-rules-check', 'docs-check', 'docs-verify-idempotent'])
    assert.ok(selected.includes(target), `selected ${selected}`);
  assert.ok(!selected.includes('rust-check'), `selected ${selected}`);
});

caseTest('a declared pattern matches by path segment', 5000, async () => {
  const owner = inputs => ({ scope: 'owner', inputs });
  const declared = { one: owner(['docs/*.md']), deep: owner(['docs/**']), rust: owner(['clients/rust/**/*.rs']), any: owner(['**']) };
  assert.deepEqual(targets(selectTargets(declared, ['docs/a/b.md'])), ['deep', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['docs/a.md'])), ['one', 'deep', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['clients/rust/orm/src/lib.rs'])), ['rust', 'any']);
  assert.deepEqual(targets(selectTargets(declared, ['clients/rust/Cargo.toml'])), ['any']);
});

caseTest('every target of CHECK_TARGETS declares inputs that match tracked files', 5000, async () => {
  const makefile = await readFile(new URL('Makefile', `file://${root}`), 'utf8');
  const checkTargets = /^CHECK_TARGETS = (.*)$/m.exec(makefile)[1].trim().split(/\s+/);
  const tracked = (await import('node:child_process')).execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(checkInputErrors(inputs, checkTargets, tracked), []);
  assert.deepEqual(checkInputErrors({ a: { scope: 'owner', needs: [], inputs: ['docs/**'] }, b: { scope: 'owner', needs: [], inputs: ['nothing/**'] } }, ['a', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no scope of c of CHECK_TARGETS',
    'contracts/check-inputs.json declares b, which is not in CHECK_TARGETS',
    'contracts/check-inputs.json: b input nothing/** matches no tracked file',
  ]);
});

// selected target은 owner-check의 서버와 decimal 환경을 받고, Rust target directory는 받지 않는다: 각 checkout은 자기
// target directory에 build한다(AGENTS.md).
caseTest('a selected make target runs with the environments of owner-check and the target directory of its checkout', 5000, async () => {
  assert.deepEqual(makeArguments('docs-check', {}), ['--no-print-directory', '-k', 'docs-check']);
  assert.deepEqual(makeArguments('client-db-check', { ORM_OWNER_TEST_ENV: '/main/.runtime/servers/env', DECIMAL_ENV: '/main/.runtime/decimal-env', CARGO_TARGET_DIR: '/main/cargo-target' }),
    ['--no-print-directory', '-k', 'TEST_ENV=/main/.runtime/servers/env', 'DECIMAL_ENV=/main/.runtime/decimal-env', 'client-db-check']);
});

// T42은 네 client에 걸친 변경이었다. 그 모양의 변경은 바뀐 기능의 검사와 file 단위의 owner target만
// 고르고, 전체 suite target(scope suite)은 make check만 실행한다.
const t42 = [
  'clients/go/orm/statement_events_test.go', 'clients/go/orm/events.go',
  'clients/php/src/StatementEvent.php', 'clients/php/tests/statement_events_test.php',
  'clients/rust/orm/src/events.rs', 'clients/rust/orm/tests/statement_events.rs',
  'clients/typescript/src/events.ts', 'clients/typescript/tests/statement-events.mjs',
  'contracts/fixtures/statement_events.dbs',
];

caseTest('a change across the four clients selects no full-suite target', 5000, async () => {
  assert.deepEqual(targets(selectTargets(inputs, t42)), ['repo-check', 'go-fmt-check', 'go-vet-check', 'rust-fmt-check']);
  for (const target of ['client-db-check', 'client-pooler-check', 'case-database-check', 'conformance-check', 'feature-check', 'go-test-check'])
    assert.equal(inputs[target].scope, 'suite', `${target} is not a full-suite target`);
  // contracts/interfaces.json과 contracts/symbols/*.json이 적는 source는 interface 검사의 입력이다.
  const owners = await selectOwners(manifest, root, t42);
  assert.deepEqual(ids(owners), ['statement_events', 'interface_contract']);
  assert.deepEqual(selected(owners.slice(0, 1)), [
    'statement_events/statement-events-go', 'statement_events/statement-events-typescript', 'statement_events/statement-events-php', 'statement_events/statement-events-rust',
    'statement_events/coverage/owner/go', 'statement_events/coverage/owner/php', 'statement_events/coverage/owner/rust', 'statement_events/coverage/owner/typescript',
  ]);
});

caseTest('a target without a scope declaration fails the selection', 5000, async () => {
  assert.throws(() => selectTargets({ a: { inputs: ['docs/**'] } }, ['docs/x.md']),
    { message: 'contracts/check-inputs.json declares no scope of a; declare owner or suite' });
  assert.throws(() => selectTargets({ a: ['docs/**'] }, ['README.md']),
    { message: 'contracts/check-inputs.json declares no scope of a; declare owner or suite' });
  assert.deepEqual(targets(selectTargets({ a: { scope: 'suite' }, b: { scope: 'owner', inputs: ['docs/**'] } }, ['docs/x.md'])), ['b']);
  assert.deepEqual(checkInputErrors({ a: { needs: [], inputs: ['docs/**'] }, b: { scope: 'suite', needs: [], inputs: ['docs/**'] }, c: { scope: 'owner', needs: [] } }, ['a', 'b', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no scope of a of CHECK_TARGETS',
    'contracts/check-inputs.json: suite target b declares inputs, which owner-check never reads',
    'contracts/check-inputs.json declares no inputs of owner target c',
  ]);
});

// needs case(G5.38-1, G5.52)는 setup 단계 선언을 검사한다: 모든 target이 needs를 선언하고, 그 값은 setup 단계 databases나
// CI setup step이 마련하는 것(scripts/check/ci-setup.mjs)이다.
caseTest('every target declares the setup steps it needs', 5000, async () => {
  assert.deepEqual(checkInputErrors({ a: { scope: 'suite' }, b: { scope: 'suite', needs: ['servers'] }, c: { scope: 'suite', needs: ['databases'] } }, ['a', 'b', 'c'], []), [
    'contracts/check-inputs.json declares no needs of a; declare [] or the setup it needs (databases, go, node-modules, rust, php-min, php, composer, server-programs)',
    'contracts/check-inputs.json: b needs servers, which no setup step provides; the needs are databases, go, node-modules, rust, php-min, php, composer, server-programs',
  ]);
});

caseTest('a changed feature entry of contracts/features.json selects that feature only', 5000, async () => {
  const feature = (id, n) => ({ id, n, verification: [{ id: 'c', command: 'x', inputs: ['x.php'] }] });
  const before = { manifest_version: 1, features: [feature('one', 1), feature('two', 1)] };
  const after = { manifest_version: 1, features: [feature('one', 2), feature('two', 1), feature('three', 1)] };
  assert.deepEqual(manifestChanges(before, after), { features: ['one', 'three'], helpers: [], whole: false });
  assert.deepEqual(manifestChanges(before, { ...after, manifest_version: 2 }), { features: ['one', 'three'], helpers: [], whole: true });
  assert.deepEqual(manifestChanges(before, { ...before, features: before.features.slice(1) }), { features: [], helpers: [], whole: true });
  assert.deepEqual(manifestChanges(null, after), { features: ['one', 'two', 'three'], helpers: [], whole: true });
  const owners = await selectOwners(after, root, ['contracts/features.json'], manifestChanges(before, after));
  assert.deepEqual(owners.map(owner => owner.feature.id), ['one', 'three']);
  assert.deepEqual(owners[0].commands, [{ id: 'c', reasons: ['contracts/features.json (entry of one)'] }]);
  const helped = { ...after, helpers: [{ id: 'h', paths: ['x.php'], tests: [], command: 'php x' }] };
  assert.deepEqual(manifestChanges(after, helped), { features: [], helpers: ['h'], whole: false });
  assert.deepEqual((await selectHelpers(helped, root, ['contracts/features.json'], manifestChanges(after, helped))).map(({ helper, reasons }) => [helper.id, reasons]),
    [['h', ['contracts/features.json (entry of h)']]]);
});

// 실행 database case는 owner-check가 자기 bench와 decimal database를 만들 target을 고르는 방법과, 그
// database의 환경 file을 읽는 방법을 확인한다.
caseTest('owner-check creates the databases of its run for a target that reads the server environment', 5000, () => {
  const { environmentFile, usesTestEnv } = ownerSelection;
  const makefile = 'WITH_TEST_ENV = x\nuses:\n\t$(WITH_TEST_ENV) go test ./a\n\nplain:\n\tnode --test a.test.mjs\n';
  assert.equal(usesTestEnv(makefile, 'uses'), true);
  assert.equal(usesTestEnv(makefile, 'plain'), false);
  assert.equal(usesTestEnv(makefile, 'absent'), false);
  assert.deepEqual(environmentFile("export BENCH_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_owner_1_ab_bench?timezone=%2B00:00'\n\nexport A='b c'\n"),
    { BENCH_MYSQL_DSN: 'mysql://root@127.0.0.1:1/orm_owner_1_ab_bench?timezone=%2B00:00', A: 'b c' });
  assert.throws(() => environmentFile('A=b\n'), /unexpected environment line: A=b/);
});

// 행동 시험 case(G5.51)는 owner-check가 바뀐 path마다 그 행동을 시험하는 것을 고르는지 본다. inputs가 아니라
// lints만 맞춘 path(go vet, gofmt, 문서 규칙)는 시험받지 않은 것이고, paths에 scope를 선언한 path는 그 선언으로
// 통과한다.
caseTest('a path that only a lint selects is untested unless its scope is declared', 5000, () => {
  const declared = { lint: { scope: 'owner', needs: [], lints: ['**/*.go'] }, unit: { scope: 'owner', needs: [], inputs: ['a/*_test.go'], lints: ['**/*.go'] } };
  const targets = selectTargets(declared, ['a/x.go', 'a/x_test.go', 'b/LICENSE']);
  assert.deepEqual(targets.map(({ target, tested }) => [target, tested]), [['lint', []], ['unit', ['a/x_test.go']]]);
  const empty = { owners: [], helpers: [], targets, exists: () => true };
  assert.deepEqual(untestedPaths(['a/x.go', 'a/x_test.go', 'b/LICENSE'], { ...empty, paths: {} }), ['a/x.go', 'b/LICENSE']);
  assert.deepEqual(untestedPaths(['a/x.go', 'b/LICENSE'], { ...empty, paths: { 'b/LICENSE': { scope: 'lint', reason: 'license text' } } }), ['a/x.go']);
  assert.deepEqual(untestedPaths(['gone.go'], { ...empty, paths: {}, exists: () => false }), []);
  assert.deepEqual(pathScopeErrors({ 'a/*.go': { scope: 'suite', reason: 'r' }, 'b/LICENSE': { scope: 'any', reason: '' }, 'c/x': { scope: 'lint', reason: 'r' } }, ['b/LICENSE']), [
    'contracts/check-inputs.json paths: a/*.go is a pattern; declare each path',
    'contracts/check-inputs.json paths: b/LICENSE declares scope any; declare lint or suite',
    'contracts/check-inputs.json paths: b/LICENSE declares no reason',
    'contracts/check-inputs.json paths: c/x is not a tracked file',
  ]);
});

caseTest('a generator source selects the check that regenerates the models', 5000, () => {
  const { targets: declared } = JSON.parse(readFileSync(new URL('contracts/check-inputs.json', `file://${root}`), 'utf8'));
  const selected = selectTargets(declared, ['generator/gen_go.go']).filter(({ tested }) => tested.length).map(({ target }) => target);
  assert.deepEqual(selected, ['go-model-check']);
});

// 전체 tree case는 추적하는 file마다 행동 시험이나 scope 선언이 있는지 본다. 하나라도 없으면 그 file을 적고 실패한다.
caseTest('every tracked file selects a behaviour test or declares its scope', 30000, async () => {
  const declarations = JSON.parse(readFileSync(new URL('contracts/check-inputs.json', `file://${root}`), 'utf8'));
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const owners = await selectOwners(manifest, root, tracked);
  const helpers = await selectHelpers(manifest, root, tracked);
  const targets = selectTargets(declarations.targets, tracked);
  assert.deepEqual(untestedPaths(tracked, { owners, helpers, targets, paths: declarations.paths, exists: () => true }), []);
  assert.deepEqual(pathScopeErrors(declarations.paths, tracked), []);
});
