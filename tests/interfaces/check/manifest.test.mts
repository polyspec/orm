// The manifest's own checks: correspondence of component methods and rules, the prohibited symbol list, error labels and catalog, and the result type of getsCount.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { allRules, behaviorCompletionErrors, checkErrorLabels, readErrorCatalog, readManifest, validateBehaviorAdapters, validateManifest, validateProhibitions, type BehaviorContract, type Component, type Manifest, type Native, type Rule, type Sequence } from './manifest.mts';
import { checkBehaviorAdapterCases, checkNativeSurfaces } from './contract.mts';

const root = resolve(import.meta.dirname, '../../..');

// componentManifest is the smallest manifest that validateManifest accepts, with components and rules removed.
function componentManifest(components: Component[], ...rules: string[]): Manifest {
  return {
    version: 1,
    languages: { go: {}, php: {}, rust: {}, typescript: {}, python: {} },
    symbol_hashes: { go: '', php: '', rust: '', typescript: '', python: '' },
    prohibited_symbols: ['multi_statement'],
    sequences: [{ id: 's' }],
    components,
    rules: rules.map(id => ({ id })),
    behavior_adapters: [{
      id: 'CFG-9', completion_item: 'KSTD-2-11-16', parity: 'unit', adapters: Object.fromEntries(['go', 'php', 'php-extension', 'python', 'rust', 'typescript'].map(runtime => [runtime, {
        status: 'unresolved', item: 'fixture', required_case: 'cancellation-case',
      }])),
    }],
  };
}

const refusal = (m: Manifest): string => {
  try {
    validateManifest(m);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

caseTest('the manifest refuses a component method without a rule', COMPUTE, () => {
  const component = { id: 'Dbspec', methods: ['readFile', 'readSet'] };
  assert.equal(refusal(componentManifest([component], 'Dbspec.readFile', 'Dbspec.readSet')), '', 'a component whose every method has a rule was refused');
  const message = refusal(componentManifest([component], 'Dbspec.readFile'));
  assert.notEqual(message, '', 'the manifest check accepted the component method Dbspec.readSet that no rule declares');
  assert.match(message, /Dbspec\.readSet/, 'the refusal does not name the method Dbspec.readSet');
});

caseTest('the component methods of the manifest have rules', COMPUTE, () => {
  validateManifest(readManifest(join(root, 'contracts/interfaces.json')));
});

caseTest('the manifest refuses a rule without a component method', COMPUTE, () => {
  const component = { id: 'SchemaUtils', methods: ['register'] };
  for (const id of ['SchemaUtils.addTablesAndColumns', 'Missing.register']) {
    const message = refusal(componentManifest([component], 'SchemaUtils.register', id));
    assert.notEqual(message, '', `the manifest check accepted the rule ${id} whose method no component lists`);
    assert.ok(message.includes(id), `the refusal does not name the rule ${id}: ${message}`);
  }
});

// An internal component (its "internal" field gives the reason) is behavior each client implements privately without a common signature: the
// method has no rule, and no rule can point to that method.
caseTest('the methods of an internal component have no rule', COMPUTE, () => {
  const internal = { id: 'Planner', methods: ['plan'], internal: 'Each client plans privately.', internal_ko: '각 client가 비공개로 plan한다.' };
  assert.equal(refusal(componentManifest([internal])), '', 'the method of an internal component was refused for having no rule');
  assert.match(refusal(componentManifest([internal], 'Planner.plan')), /Planner\.plan/, 'the manifest check accepted the rule Planner.plan of an internal component');
  for (const half of [{ id: 'Planner', methods: ['plan'], internal: 'Each client plans privately.' }, { id: 'Planner', methods: ['plan'], internal_ko: '각 client가 비공개로 plan한다.' }]) {
    assert.match(refusal(componentManifest([half])), /Planner/, 'the manifest check accepted an internal component without its grounding in both languages');
  }
});

caseTest('the multi_statement prohibition is mandatory', COMPUTE, () => {
  for (const prohibited of [['query_cancel'], ['multi_statement', 'multi_statement', 'query_cancel']]) {
    assert.throws(() => validateProhibitions(prohibited), `invalid prohibited symbol list accepted: ${prohibited.join(', ')}`);
  }
  validateProhibitions(['multi_statement', 'query_cancel']);
});

caseTest('the error labels of the manifest match the catalog', COMPUTE, () => {
  const manifest = readManifest(join(root, 'contracts/interfaces.json'));
  assert.deepEqual(checkErrorLabels(readErrorCatalog(root), allRules(manifest), manifest.sequences ?? []), [], 'interface error labels differ from catalog');
});

caseTest('the interface error labels reject contract mutations', COMPUTE, () => {
  const codes = new Set(['CONFIG', 'DEADLOCK']);
  const rules: Rule[] = [{ id: 'Db.transaction', errors: ['CONFIG', 'DEADLOCK'] }];
  const sequences: Sequence[] = [{ id: 'errors', expected: ['CONFIG'] }];
  assert.deepEqual(checkErrorLabels(codes, rules, sequences), [], 'valid labels failed');
  const mutations: Record<string, () => void> = {
    'unknown rule code': () => { rules[0] = { ...rules[0], errors: ['CONFIG', 'DEADLOK'] }; },
    'duplicate rule code': () => { rules[0] = { ...rules[0], errors: ['CONFIG', 'CONFIG'] }; },
    'unknown result code': () => { sequences[0] = { ...sequences[0], expected: ['TYPO'] }; },
    'non-string result code': () => { sequences[0] = { ...sequences[0], expected: [7] }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    rules[0] = { id: 'Db.transaction', errors: ['CONFIG', 'DEADLOCK'] };
    sequences[0] = { id: 'errors', expected: ['CONFIG'] };
    mutate();
    assert.notDeepEqual(checkErrorLabels(codes, rules, sequences), [], `${name} passed`);
  }
});

caseTest('getsCount uses the dedicated grouped rows in every client', COMPUTE, () => {
  const manifest = readManifest(join(root, 'contracts/interfaces.json'));
  const rule = manifest.rules?.find(r => r.id === 'Model.getsCount');
  assert.ok(rule, 'getsCount common rule is missing');
  assert.equal(rule.output, 'GroupRows', `getsCount common output = ${rule.output ?? ''}, want GroupRows`);
  for (const language of ['go', 'php', 'rust', 'typescript', 'python']) {
    const native: Native | undefined = rule.native?.[language];
    assert.ok(native, `getsCount has no ${language} native signature`);
    const signature: string = native.signature ?? '';
    assert.ok(signature.includes('GroupRows') && !signature.includes('Collection'), `getsCount ${language} native signature returns a model collection: ${signature}`);
  }
});

caseTest('CFG-9 records six explicit adapters and refuses fake, missing, or unresolved-as-pass entries', COMPUTE, () => {
  const manifest = readManifest(join(root, 'contracts/interfaces.json'));
  validateManifest(manifest);
  const contract = manifest.behavior_adapters?.find(adapter => adapter.id === 'CFG-9');
  assert.ok(contract, 'CFG-9 adapter contract is missing');
  assert.deepEqual(Object.keys(contract.adapters ?? {}).sort(), ['go', 'php', 'php-extension', 'python', 'rust', 'typescript']);
  assert.equal((contract.adapters?.php?.status), 'unresolved', 'PHP cancellation was counted as implemented');
  assert.equal((contract.adapters?.['php-extension']?.status), 'unresolved', 'PHP extension cancellation was counted as implemented');
  assert.equal(behaviorCompletionErrors(contract).length, 2, 'unresolved PHP adapters did not block six-client completion');

  const surfaces = manifest.native_surfaces ?? [];
  const goSurface = surfaces.find(surface => surface.owner === 'go');
  assert.ok(goSurface);
  assert.deepEqual(checkNativeSurfaces('go', { [goSurface.symbol ?? '']: { signature: goSurface.signature ?? '', exported: true } }, surfaces), []);
  assert.notDeepEqual(checkNativeSurfaces('go', {}, surfaces), [], 'a fake Go host primitive passed');
  const tsSurface = surfaces.find(surface => surface.owner === 'typescript');
  assert.ok(tsSurface);
  assert.deepEqual(checkNativeSurfaces('typescript', { [tsSurface.symbol ?? '']: { signature: tsSurface.signature ?? '', exported: true } }, surfaces), []);
  const actual = { 'packages/python/src/polyspec/orm/database.py::Db.with_future': { signature: 'def with_future(self, future: asyncio.Future) -> Db', exported: true } };
  assert.deepEqual(checkNativeSurfaces('python', actual, surfaces), [], 'real Python host primitive did not match');
  assert.notDeepEqual(checkNativeSurfaces('python', {}, surfaces), [], 'a fake host primitive passed');

  const copy = (): BehaviorContract => structuredClone(contract);
  const missing = copy();
  delete missing.adapters?.rust;
  assert.throws(() => validateBehaviorAdapters([missing], surfaces), /CFG-9/);
  const noCases = copy();
  if (noCases.adapters?.go) noCases.adapters.go.cases = [];
  assert.throws(() => validateBehaviorAdapters([noCases], surfaces), /go: implemented adapter requires/);
  const missingSurface = copy();
  if (missingSurface.adapters?.go) delete missingSurface.adapters.go.surface;
  assert.throws(() => validateBehaviorAdapters([missingSurface], surfaces), /go: implemented adapter requires/);
  const unresolvedAsPass = copy();
  if (unresolvedAsPass.adapters?.php) unresolvedAsPass.adapters.php.status = 'implemented';
  assert.throws(() => validateBehaviorAdapters([unresolvedAsPass], surfaces), /php: implemented adapter requires/);
});

caseTest('behavior adapters must match exact parity bindings', COMPUTE, () => {
  const contract: BehaviorContract = {
    id: 'CFG-9', parity: 'cancel-query', adapters: {
      go: { status: 'implemented', primitive: 'context.Context', cases: [{ test: 'cancel_test.go', id: 'TestCancel' }] },
      php: { status: 'unresolved', item: 'KSTD-2-11-16-1', required_case: 'cancel_active_query' },
    },
  };
  const runtimes = ['php-extension', 'python', 'rust', 'typescript'] as const;
  const adapters = contract.adapters;
  assert.ok(adapters);
  for (const runtime of runtimes) adapters[runtime] = { status: 'unresolved', item: 'fixture', required_case: 'cancel' };
  const unit = { id: 'cancel-query', bindings: [{ implementation: 'go', test: 'cancel_test.go', id: 'TestCancel' }] };
  assert.deepEqual(checkBehaviorAdapterCases([contract], [unit]), []);
  assert.notDeepEqual(checkBehaviorAdapterCases([contract], [{ ...unit, bindings: [] }]), [], 'missing native case passed');
  assert.notDeepEqual(checkBehaviorAdapterCases([contract], [{ ...unit, bindings: [{ implementation: 'go', test: 'fake.go', id: 'TestCancel' }] }]), [], 'fake native symbol/case passed');
});
