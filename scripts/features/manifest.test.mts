// The schema of contracts/features.json (scripts/features/schema/features.schema.json) accepts the repository's manifest and
// refuses each shape outside it, and the schema of a shared fixture refuses a fixture without its feature or its cases.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { parseJson, refusedPaths, SchemaError } from '../json/schema.mts';
import { parseFeatures, readFeatures, type ManifestFeature } from './manifest.mts';
import { completionItemAdapterErrors } from './behavior-adapters.mts';
import { readCheckInputs } from '../check/inputs.mts';
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
const adapterChecklist = (state: string): string => [
  '| ID | Task | Deliverables | Verification | State |',
  '|---|---|---|---|---|',
  `| KSTD-2-11-16 | Handle cancellation | Native adapters | owner tests | ${state} |`,
].join('\n');
function unresolvedCfg9Contract() {
  const source = readInterfaceManifest(new URL('../../contracts/interfaces.json', import.meta.url).pathname).behavior_adapters?.find(value => value.id === 'CFG-9');
  assert.ok(source, 'CFG-9 adapter contract is missing');
  const contract = structuredClone(source);
  for (const runtime of ['php', 'php-extension']) {
    const adapter = contract.adapters?.[runtime];
    assert.ok(adapter, `CFG-9 ${runtime} adapter is missing`);
    adapter.status = 'unresolved';
  }
  return contract;
}

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

caseTest('canonical non-done checklist states allow unresolved runtime adapters', COMPUTE, () => {
  const contract = unresolvedCfg9Contract();
  for (const state of [
    '[ ]',
    '[~]',
    '[!] cause: deferred by the user; retry: after PHP adapter implementation',
    '[-] cause: adapter contract superseded',
  ]) {
    assert.deepEqual(completionItemAdapterErrors(adapterChecklist(state), [contract]), [], `${state} was refused`);
  }
});

caseTest('a done checklist item still requires every declared runtime adapter', COMPUTE, () => {
  const contract = unresolvedCfg9Contract();
  const failures = completionItemAdapterErrors(adapterChecklist('[o]'), [contract]);
  assert.ok(failures.some(error => error.includes('KSTD-2-11-16: CFG-9/php: unresolved native behavior adapter')),
    'item completion passed with unresolved PHP cancellation');
  assert.ok(failures.some(error => error.includes('KSTD-2-11-16: CFG-9/php-extension: unresolved native behavior adapter')),
    'item completion passed with unresolved PHP extension cancellation');
});

caseTest('missing and non-canonical checklist states fail the adapter guard', COMPUTE, () => {
  const contract = unresolvedCfg9Contract();
  for (const state of ['', '[x]', '[!] cause: deferred without retry', '[o] cause: invalid suffix']) {
    const errors = completionItemAdapterErrors(adapterChecklist(state), [contract]);
    assert.ok(errors.some(error => error.includes('KSTD-2-11-16 has no recognized state')), `${state || '(empty)'} was accepted`);
  }
  assert.ok(completionItemAdapterErrors('', [contract]).some(error => error.includes('missing checklist item')),
    'missing owning checklist item passed');
});

// This guards the manifest state only; native behavior is exercised by the declared extension owner tests and coverage runs.
caseTest('the features whose PHP extension owner runs the shared cases are implemented', COMPUTE, () => {
  for (const id of ['planner', 'parameter_chunking', 'composite_keys',
    'dsn_connection', 'transactions', 'statement_events', 'audit_triggers',
    'request_hook', 'constraints_and_relations', 'complex_query']) {
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


const markdownServerContracts = [
  { path: 'packages/php/tests/markdown_test_server.php', required: ['$receivedMessages = [];'], forbidden: ['$received = [];', 'markdown_fake_server.php'] },
  { path: 'packages/php/tests/MarkdownTest.php', required: ['function start_markdown_test_server(', 'function markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php/tests/IrAnswersTest.php', required: ['start_markdown_test_server(', 'markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php/tests/WasInsertedTest.php', required: ['start_markdown_test_server(', 'markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php-ext/tests/ModelWriteSurfaceTest.php', required: ['start_markdown_test_server(', 'markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php-ext/tests/OrmExceptionNativeTest.php', required: ['markdownTestServerCode(', 'startMarkdownTestServer(', 'stopMarkdownTestServer('], forbidden: ['markdownServerCode(', 'startMarkdownServer(', 'stopMarkdownServer('] },
  { path: 'packages/go/orm/markdown_test.go', required: ['type markdownTestServer struct', 'receivedMessages', 'startMarkdownTestServer('], forbidden: ['type fakeServer struct', 'startFakeServer('] },
  { path: 'packages/go/markdownmodel/ir_answers_test.go', required: ['startMarkdownTestServerWithKeyedAnswers(', 'startMarkdownTestServerWithAnswer(', 'listenMarkdownTestServer(', 'serveMarkdownTestConnection('], forbidden: ['keyedServer(', 'answeringServer(', 'listenLocal(', 'serveListener('] },
  { path: 'packages/python/tests/test_markdown.py', required: ['class MarkdownTestServer:', 'def received_messages(self)', 'self._received_messages'], forbidden: ['class FakeServer:', 'def messages(self)', 'self.received_messages:'] },
  { path: 'packages/python/tests/test_was_inserted.py', required: ['MarkdownTestServer'], forbidden: ['FakeServer'] },
  { path: 'packages/python/tests/ir_answers.py', required: ['start_markdown_test_server_with_keyed_answers(', 'start_markdown_test_server_with_answer(', 'listen_markdown_test_server(', 'accept_markdown_test_connection('], forbidden: ['keyed_server(', 'answering_server(', 'listen_once(', 'accept_once('] },
  { path: 'packages/rust/orm/tests/markdown.rs', required: ['struct MarkdownTestServer', 'received_messages', 'start_markdown_test_server('], forbidden: ['struct FakeServer', 'fake_server('] },
  { path: 'packages/ts/tests/markdown.mjs', required: ['startMarkdownTestServer(', 'receivedMessages'], forbidden: ['fakeServer(', '.received;'] },
  { path: 'packages/ts/tests/ir_answers.mjs', required: ['startMarkdownTestServerWithKeyedAnswers(', 'startMarkdownTestServerWithAnswer(', 'listenMarkdownTestServer('], forbidden: ['keyedServer(', 'answeringServer(', 'listenMarkdownServer('] },
  { path: 'packages/ts/tests/markdown_test_listener.mjs', required: ['listenMarkdownTestServer('], forbidden: ['listenMarkdownServer('] },
  { path: 'packages/ts/tests/markdown_test_listener.test.mjs', required: ['listenMarkdownTestServer('], forbidden: ['listenMarkdownServer('] },
] as const;

function markdownNamingErrors(sources: Record<string, string>, registrations: Record<string, string[]>): string[] {
  const errors: string[] = [];
  for (const contract of markdownServerContracts) {
    const source = sources[contract.path];
    if (source === undefined) {
      errors.push(`${contract.path}: missing source`);
      continue;
    }
    for (const symbol of contract.required)
      if (!source.includes(symbol)) errors.push(`${contract.path}: missing ${symbol}`);
    for (const symbol of contract.forbidden)
      if (source.includes(symbol)) errors.push(`${contract.path}: stale ${symbol}`);
  }
  for (const owner of ['dsn_connection fixtures', 'markdown-session-php inputs', 'client-unit-check inputs'])
    if (!registrations[owner]?.includes('packages/php/tests/markdown_test_server.php')) errors.push(`${owner}: PHP Markdown test server is not registered`);
  if (!registrations['typescript-listener']?.includes('packages/ts/tests/markdown_test_listener.mjs'))
    errors.push('typescript-listener: renamed listener path is not registered');
  return errors;
}

caseTest('Markdown test server names and owner registrations stay aligned across clients', COMPUTE, () => {
  const parity = readFileSync(`${root}/config/parity.json`, 'utf8');
  assert.ok(parity.includes('packages/php/tests/markdown_test_server.php'), 'parity omits the PHP Markdown test server');
  assert.ok(!parity.includes('markdown_fake_server.php'), 'parity retains the previous PHP Markdown test server path');
  const connection = manifest.features.find(feature => feature.id === 'dsn_connection');
  assert.ok(connection, 'contracts/features.json omits dsn_connection');
  const phpVerification = connection.verification.find(item => item.id === 'markdown-session-php');
  assert.ok(phpVerification, 'dsn_connection omits its PHP Markdown session owner');
  assert.ok(phpVerification.inputs, 'markdown-session-php has no declared inputs');
  const checks = readCheckInputs(root);
  const helper = (manifest.helpers ?? []).find(item => item.id === 'typescript-markdown-listener');
  assert.ok(helper, 'contracts/features.json omits the TypeScript Markdown listener helper');
  const clientUnit = checks.targets['client-unit-check'];
  assert.ok(clientUnit, 'client-unit-check has no input declaration');
  const clientInputs = clientUnit.inputs;
  assert.ok(clientInputs, 'client-unit-check declares no inputs');
  const paths = [...new Set([
    ...connection.fixtures,
    ...phpVerification.inputs,
    ...clientInputs,
    ...helper.paths,
  ])];
  const sources = Object.fromEntries(markdownServerContracts.map(contract => [
    contract.path,
    existsSync(`${root}/${contract.path}`) ? readFileSync(`${root}/${contract.path}`, 'utf8') : '',
  ]));
  const registrations = {
    'dsn_connection fixtures': connection.fixtures,
    'markdown-session-php inputs': phpVerification.inputs,
    'client-unit-check inputs': clientInputs,
    'typescript-listener': helper.paths,
  };
  assert.deepEqual(markdownNamingErrors(sources, registrations), []);

  const phpMarkdownTest = sources['packages/php/tests/MarkdownTest.php'];
  assert.ok(phpMarkdownTest, 'PHP Markdown test source is unavailable');
  const stalePhp = { ...sources, 'packages/php/tests/MarkdownTest.php': phpMarkdownTest.replace('start_markdown_test_server(', 'markdown_fake_server(') };
  assert.match(markdownNamingErrors(stalePhp, registrations).join('\n'), /MarkdownTest\.php: missing function start_markdown_test_server/);
  assert.match(markdownNamingErrors(sources, { ...registrations, 'markdown-session-php inputs': registrations['markdown-session-php inputs'].filter(path => path !== 'packages/php/tests/markdown_test_server.php') }).join('\n'), /markdown-session-php inputs: PHP Markdown test server is not registered/);
  assert.ok(paths.includes('packages/php/tests/markdown_test_server.php'));
});
