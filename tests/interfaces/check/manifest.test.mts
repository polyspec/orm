// manifest 자신의 검사: 구성요소 method와 rule의 대응, 금지 symbol 목록, error label과 catalog, getsCount의 결과 type.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { allRules, checkErrorLabels, readErrorCatalog, readManifest, validateManifest, validateProhibitions, type Component, type Manifest, type Native, type Rule, type Sequence } from './manifest.mts';

const root = resolve(import.meta.dirname, '../../..');

// componentManifest는 구성요소와 rule을 뺀 나머지를 validateManifest가 받아들이는 가장 작은 manifest다.
function componentManifest(components: Component[], ...rules: string[]): Manifest {
  return {
    version: 1,
    languages: { go: {}, php: {}, rust: {}, typescript: {}, python: {} },
    symbol_hashes: { go: '', php: '', rust: '', typescript: '', python: '' },
    prohibited_symbols: ['multi_statement'],
    sequences: [{ id: 's' }],
    components,
    rules: rules.map(id => ({ id })),
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

// internal 구성요소("internal" field가 그 이유를 적는다)는 각 client가 공통 signature 없이 비공개로 구현하는 동작이다: 그
// method에는 rule이 없고, rule이 그 method를 가리킬 수 없다.
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
