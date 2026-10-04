import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { caseTest } from '../../tests/testcase.mjs';
import * as ownerSelection from './owners.mjs';

const { checkInputErrors, makeArguments, manifestChanges, selectOwners, selectTargets } = ownerSelection;

const root = new URL('../..', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(new URL('contracts/features.json', `file://${root}`), 'utf8'));
const ids = owners => owners.map(owner => owner.feature.id);

// 각 case는 repository file만 읽으므로 기한은 5 s다.
caseTest('a changed fixture selects every feature whose fixtures render it', 5000, async () => {
  // schema_definition은 contracts/fixtures/schema_definition.json에서 audit.dbs를 렌더링한다.
  const owners = await selectOwners(manifest, root, ['contracts/fixtures/audit.dbs']);
  assert.ok(ids(owners).includes('schema_definition'), `selected ${ids(owners)}`);
  assert.ok(ids(owners).includes('audit_triggers'), `selected ${ids(owners)}`);
  const reason = owners.find(owner => owner.feature.id === 'schema_definition').reasons;
  assert.deepEqual(reason, ['contracts/fixtures/audit.dbs (named by contracts/fixtures/schema_definition.json)']);
});

caseTest('a changed test or vector file selects the feature that declares it', 5000, async () => {
  assert.deepEqual(ids(await selectOwners(manifest, root, ['clients/go/orm/external_documents_test.go'])), ['schema_install']);
  assert.ok(ids(await selectOwners(manifest, root, ['tests/dbspec/cases.json'])).includes('schema_definition'));
});

caseTest('a path that no feature declares selects nothing', 5000, async () => {
  assert.deepEqual(await selectOwners(manifest, root, ['README.md', 'docs/checklist.md']), []);
});

caseTest('a file named by a file that a fixture names selects the feature', 5000, async () => {
  // contracts/interfaces.json은 contracts/symbols/rust.json을 적고, 그 snapshot은 Rust source의 symbol을 적는다.
  const owners = await selectOwners(manifest, root, ['clients/rust/orm/src/tx_send_tests.rs']);
  assert.deepEqual(ids(owners), ['interface_contract']);
  assert.deepEqual(owners[0].reasons, ['clients/rust/orm/src/tx_send_tests.rs (named by contracts/symbols/rust.json)']);
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
  assert.deepEqual(checkInputErrors({ a: { scope: 'owner', inputs: ['docs/**'] }, b: { scope: 'owner', inputs: ['nothing/**'] } }, ['a', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no scope of c of CHECK_TARGETS',
    'contracts/check-inputs.json declares b, which is not in CHECK_TARGETS',
    'contracts/check-inputs.json: b input nothing/** matches no tracked file',
  ]);
});

caseTest('a selected make target runs with the environments and the Rust target directory of owner-check', 5000, async () => {
  assert.deepEqual(makeArguments('docs-check', {}), ['--no-print-directory', 'docs-check']);
  assert.deepEqual(makeArguments('client-db-check', { ORM_OWNER_TEST_ENV: '/main/.runtime/servers/env', DECIMAL_ENV: '/main/.runtime/decimal-env', ORM_OWNER_CARGO_TARGET_DIR: '/main/cargo-target' }),
    ['--no-print-directory', 'TEST_ENV=/main/.runtime/servers/env', 'DECIMAL_ENV=/main/.runtime/decimal-env', 'CARGO_TARGET_DIR=/main/cargo-target', 'client-db-check']);
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
  assert.deepEqual(targets(selectTargets(inputs, t42)), ['repo-check', 'go-fmt-check', 'rust-fmt-check']);
  for (const target of ['client-db-check', 'client-pooler-check', 'case-database-check', 'conformance-check', 'feature-check', 'go-test-check'])
    assert.equal(inputs[target].scope, 'suite', `${target} is not a full-suite target`);
  assert.deepEqual(ids(await selectOwners(manifest, root, t42)), ['statement_events', 'interface_contract']);
});

caseTest('a target without a scope declaration fails the selection', 5000, async () => {
  assert.throws(() => selectTargets({ a: { inputs: ['docs/**'] } }, ['docs/x.md']),
    { message: 'contracts/check-inputs.json declares no scope of a; declare owner or suite' });
  assert.throws(() => selectTargets({ a: ['docs/**'] }, ['README.md']),
    { message: 'contracts/check-inputs.json declares no scope of a; declare owner or suite' });
  assert.deepEqual(targets(selectTargets({ a: { scope: 'suite' }, b: { scope: 'owner', inputs: ['docs/**'] } }, ['docs/x.md'])), ['b']);
  assert.deepEqual(checkInputErrors({ a: { inputs: ['docs/**'] }, b: { scope: 'suite', inputs: ['docs/**'] }, c: { scope: 'owner' } }, ['a', 'b', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no scope of a of CHECK_TARGETS',
    'contracts/check-inputs.json: suite target b declares inputs, which owner-check never reads',
    'contracts/check-inputs.json declares no inputs of owner target c',
  ]);
});

caseTest('a changed feature entry of contracts/features.json selects that feature only', 5000, async () => {
  const before = { manifest_version: 1, features: [{ id: 'one', fixtures: [], tests: [], n: 1 }, { id: 'two', fixtures: [], tests: [] }] };
  const after = { manifest_version: 1, features: [{ id: 'one', fixtures: [], tests: [], n: 2 }, { id: 'two', fixtures: [], tests: [] }, { id: 'three', fixtures: [], tests: [] }] };
  assert.deepEqual(manifestChanges(before, after), { features: ['one', 'three'], whole: false });
  assert.deepEqual(manifestChanges(before, { ...after, manifest_version: 2 }), { features: ['one', 'three'], whole: true });
  assert.deepEqual(manifestChanges(before, { ...before, features: before.features.slice(1) }), { features: [], whole: true });
  assert.deepEqual(manifestChanges(null, after), { features: ['one', 'two', 'three'], whole: true });
  const owners = await selectOwners(after, root, ['contracts/features.json'], manifestChanges(before, after));
  assert.deepEqual(owners.map(owner => [owner.feature.id, owner.reasons]), [
    ['one', ['contracts/features.json (entry of one)']],
    ['three', ['contracts/features.json (entry of three)']],
  ]);
});
