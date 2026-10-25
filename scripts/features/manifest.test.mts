// The schema of contracts/features.json (scripts/features/schema/features.schema.json) accepts the repository's manifest and
// refuses each shape outside it, and the schema of a shared fixture refuses a fixture without its feature or its cases.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { parseJson, refusedPaths, SchemaError } from '../json/schema.mts';
import { parseFeatures, readFeatures, type ManifestFeature } from './manifest.mts';
import { completionItemAdapterErrors } from './behavior-adapters.mts';
import { readManifest as readInterfaceManifest } from '../../tests/interfaces/check/manifest.mts';

const root = new URL('../..', import.meta.url).pathname;
const manifest = readFeatures(root);
const first = manifest.features[0];
assert.ok(first, 'contracts/features.json declares a feature');

// refused is the instance paths of the errors of a manifest, or [] when the schema accepts it.
function refused(value: unknown): string[] {
  return refusedPaths(() => parseFeatures(JSON.stringify(value), 'contracts/features.json'));
}
const withFeature = (change: (feature: ManifestFeature) => object): object => ({ ...manifest, features: [change(first)] });

caseTest('the schema of contracts/features.json accepts the repository manifest', COMPUTE, () => {
  assert.deepEqual(refused(manifest), []);
  assert.deepEqual(refused(withFeature(feature => ({ ...feature, status: 'planned', verification: [] }))), []);
});

caseTest('the schema of contracts/features.json refuses a manifest outside its shape', COMPUTE, () => {
  assert.ok(refused({ ...manifest, manifest_version: 2 }).includes('/manifest_version'));
  assert.ok(refused({ ...manifest, features: [] }).includes('/features'));
  assert.ok(refused({ ...manifest, source: { ...manifest.source, read_order: [] } }).includes('/source/read_order'));
  assert.ok(refused({ ...manifest, extra: true }).includes('/'));
  const { title: _title, ...untitled } = first;
  assert.ok(refused({ ...manifest, features: [untitled] }).includes('/features/0'));
  assert.ok(refused(withFeature(feature => ({ ...feature, status: 'done' }))).includes('/features/0/status'));
  assert.ok(refused(withFeature(feature => ({ ...feature, parity: [] }))).includes('/features/0/parity'));
  assert.ok(refused(withFeature(feature => ({ ...feature, status: 'implemented', tests: [] }))).includes('/features/0/tests'));
  assert.ok(refused(withFeature(feature => ({ ...feature, status: 'implemented', docs: [] }))).includes('/features/0/docs'));
  assert.ok(refused(withFeature(feature => ({ ...feature, status: 'partial', verification: [] }))).includes('/features/0/verification'));
  assert.ok(refused(withFeature(feature => ({ ...feature, verification: [{ id: 'a', command: '', shard: 'other' }] }))).includes('/features/0/verification/0/command'));
  assert.ok(refused(withFeature(feature => ({ ...feature, verification: [{ id: 'a', command: 'x', shard: 'other', timeout: 1 }] }))).includes('/features/0/verification/0'));
  assert.ok(refused(withFeature(feature => ({ ...feature, verification: [{ id: 'a', command: 'x', shard: 'other', environment: 'mac' }] }))).includes('/features/0/verification/0/environment'));
});

caseTest('a checklist item cannot close while a declared runtime adapter is unresolved', COMPUTE, () => {
  const contract = readInterfaceManifest(new URL('../../contracts/interfaces.json', import.meta.url).pathname).behavior_adapters?.find(value => value.id === 'CFG-9');
  assert.ok(contract, 'CFG-9 adapter contract is missing');
  const inProgress = '| KSTD-2-11-16 | Handle cancellation | [~] |';
  assert.deepEqual(completionItemAdapterErrors(inProgress, [contract]), [], 'an in-progress item was refused');
  const completed = '| KSTD-2-11-16 | Handle cancellation | [o] |';
  const failures = completionItemAdapterErrors(completed, [contract]);
  assert.ok(failures.some(error => error.includes('KSTD-2-11-16: CFG-9/php: unresolved native behavior adapter')),
    'item completion passed with unresolved PHP cancellation');
  assert.ok(failures.some(error => error.includes('KSTD-2-11-16: CFG-9/php-extension: unresolved native behavior adapter')),
    'item completion passed with unresolved PHP extension cancellation');
  assert.notDeepEqual(completionItemAdapterErrors('', [contract]), [], 'missing owning checklist item passed');
});

// This guards the manifest state only; native behavior is exercised by the declared extension owner tests and coverage runs.
caseTest('the features whose PHP extension owner runs the shared cases are implemented', COMPUTE, () => {
  for (const id of ['planner', 'parameter_chunking', 'composite_keys']) {
    const feature = manifest.features.find(item => item.id === id);
    assert.ok(feature, `contracts/features.json omits ${id}`);
    assert.equal(feature.coverage?.owners?.['php-extension']?.part, 'packages/php-ext/tests', `${id} has no PHP extension owner`);
    assert.equal(feature.status, 'implemented', `${id} is ${feature.status}`);
  }
});

caseTest('the schema of a shared fixture refuses a fixture without its feature or its cases', COMPUTE, () => {
  const schema = new URL('./schema/fixture.schema.json', import.meta.url).pathname;
  const read = (value: unknown) => {
    try {
      parseJson<object>(JSON.stringify(value), schema, 'fixture.json');
      return [];
    } catch (error) {
      assert.ok(error instanceof SchemaError, String(error));
      return error.lines;
    }
  };
  assert.deepEqual(read(JSON.parse(readFileSync(new URL('../../contracts/fixtures/planner.json', import.meta.url), 'utf8'))), []);
  assert.notDeepEqual(read({ cases: [{ id: 'a', operation: 'o', expected: 1 }] }), []);
  assert.notDeepEqual(read({ feature: 'f', cases: [] }), []);
  assert.notDeepEqual(read({ feature: 'f', cases: [{ id: 'a', operation: 'o' }] }), []);
});
