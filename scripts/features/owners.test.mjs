import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { caseTest } from '../../tests/testcase.mjs';
import { checkInputErrors, makeArguments, selectOwners, selectTargets } from './owners.mjs';

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
  const declared = { one: ['docs/*.md'], deep: ['docs/**'], rust: ['clients/rust/**/*.rs'], any: ['**'] };
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
  assert.deepEqual(checkInputErrors({ a: ['docs/**'], b: ['nothing/**'] }, ['a', 'c'], ['docs/x.md']), [
    'contracts/check-inputs.json declares no inputs of c of CHECK_TARGETS',
    'contracts/check-inputs.json declares b, which is not in CHECK_TARGETS',
    'contracts/check-inputs.json: b input nothing/** matches no tracked file',
  ]);
});

caseTest('a selected make target runs with the environments and the Rust target directory of owner-check', 5000, async () => {
  assert.deepEqual(makeArguments('docs-check', {}), ['--no-print-directory', 'docs-check']);
  assert.deepEqual(makeArguments('client-db-check', { ORM_OWNER_TEST_ENV: '/main/.runtime/servers/env', DECIMAL_ENV: '/main/.runtime/decimal-env', ORM_OWNER_CARGO_TARGET_DIR: '/main/cargo-target' }),
    ['--no-print-directory', 'TEST_ENV=/main/.runtime/servers/env', 'DECIMAL_ENV=/main/.runtime/decimal-env', 'CARGO_TARGET_DIR=/main/cargo-target', 'client-db-check']);
});
