import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { caseTest } from '../../tests/testcase.mjs';
import { selectOwners } from './owners.mjs';

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
