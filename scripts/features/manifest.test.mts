// The schema of contracts/features.json (scripts/features/schema/features.schema.json) accepts the repository's manifest and
// refuses each shape outside it, and the schema of a shared fixture refuses a fixture without its feature or its cases.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { parseJson, refusedPaths, SchemaError } from '../json/schema.mts';
import { parseFeatures, type ManifestFeature } from './manifest.mts';
import { completionItemAdapterErrors } from './behavior-adapters.mts';
import { readCheckInputs } from '../check/inputs.mts';
import { readManifest as readInterfaceManifest } from '../../tests/interfaces/check/manifest.mts';

const root = new URL('../..', import.meta.url).pathname;
// The manifest as written: readFeatures adds the cases of the recipe owners, which the schema refuses in the file.
const manifest = parseFeatures(readFileSync(new URL('../../contracts/features.json', import.meta.url), 'utf8'), 'contracts/features.json');
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

caseTest('the schema refuses a list of cases on a recipe owner and requires one on a native owner', COMPUTE, () => {
  const owner = (command: Record<string, unknown>) => withFeature(feature => ({ ...feature, coverage: {
    kind: 'independent', dependents: [], owners: { go: { part: 'p', tests: ['t'], commands: { none: [{ runner: 'go', test: 't', ...command }] } } },
  } }));
  assert.deepEqual(refused(owner({ recipe: 'r' })).filter(path => path.includes('/commands/')), []);
  assert.ok(refused(owner({ recipe: 'r', cases: ['a'] })).some(path => path.endsWith('/commands/none/0/cases')));
  assert.ok(refused(owner({})).some(path => path.endsWith('/commands/none/0')));
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
  assert.deepEqual(read({ feature: 'f', cases: [{ id: 'a', operation: 'o', expected: 1 }] }), []);
  assert.notDeepEqual(read({ cases: [{ id: 'a', operation: 'o', expected: 1 }] }), []);
  assert.notDeepEqual(read({ feature: 'f', cases: [] }), []);
  assert.notDeepEqual(read({ feature: 'f', cases: [{ id: 'a', operation: 'o' }] }), []);
});

caseTest('the composite-key recipe holds distinct bounded tuples with equal concatenations', COMPUTE, () => {
  const recipePath = 'contracts/fixtures/composite_keys/composite_keys.json';
  const feature = manifest.features.find(item => item.id === 'composite_keys');
  assert.ok(feature, 'contracts/features.json declares composite_keys');
  assert.ok(feature.fixtures.includes(recipePath), 'composite_keys declares the recipe');
  const coverageOwners = feature.coverage?.owners ?? {};
  assert.deepEqual(
    Object.keys(coverageOwners).sort(),
    ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'],
    'composite_keys declares all six client owners',
  );
  const recipe = parseJson<{
    cases: { id: string; steps: { op: string; model?: string; rows?: Record<string, { int?: string; text?: string }>[] }[] }[];
  }>(readFileSync(new URL(`../../${recipePath}`, import.meta.url), 'utf8'), new URL('schema/recipe.schema.json', import.meta.url).pathname, recipePath);
  const compositeCase = recipe.cases.find(item => item.id === 'composite_key_rows');
  assert.ok(compositeCase, 'the recipe holds composite_key_rows');
  const created = (model: string) => compositeCase.steps.find(step => step.op === 'model.creates' && step.model === model)?.rows ?? [];
  const tenantNamespace = '990004';
  const collisionName = (row: Record<string, { int?: string; text?: string }>) => row.name?.text?.startsWith('collision-') === true;
  const accounts = created('CompositeAccount').filter(collisionName);
  assert.equal(accounts.length, 2);
  const [first, second] = accounts.map(row => {
    const [tenantId, accountId] = [BigInt(row.tenant_id?.int ?? '0'), BigInt(row.account_id?.int ?? '0')];
    const role = created('CompositeMembership').find(item => item.tenant_id?.int === row.tenant_id?.int && item.account_id?.int === row.account_id?.int)?.role?.text;
    assert.ok(tenantId > 0n && tenantId <= 9223372036854775807n);
    assert.ok(accountId > 0n && accountId <= 9223372036854775807n);
    assert.ok(tenantId.toString().startsWith(tenantNamespace), 'collision tenants stay in the namespace of the recipe');
    assert.equal(typeof row.name?.text, 'string');
    assert.equal(typeof role, 'string');
    return { tenantId, accountId, name: row.name?.text, role };
  });
  assert.ok(first !== undefined && second !== undefined);
  assert.notDeepEqual([first.tenantId, first.accountId], [second.tenantId, second.accountId]);
  assert.notEqual(first.name, second.name);
  assert.notEqual(first.role, second.role);
  assert.equal(`${first.tenantId}${first.accountId}`, `${second.tenantId}${second.accountId}`);
  assert.notEqual(first.tenantId, 990004n);
  assert.notEqual(second.tenantId, 990006n);
});


const markdownServerContracts = [
  { path: 'packages/php/tests/markdown_test_server.php', required: ['$receivedMessages = [];'], forbidden: ['$received = [];', 'markdown_fake_server.php'] },
  { path: 'packages/php/tests/MarkdownTest.php', required: ['function start_markdown_test_server(', 'function markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php/tests/Recipe.php', required: ['start_markdown_test_server(', 'markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/php-ext/tests/ModelWriteSurfaceTest.php', required: ['start_markdown_test_server(', 'markdown_test_server_received_messages('], forbidden: ['markdown_fake_server(', 'markdown_received('] },
  { path: 'packages/ts/tests/recipe.mjs', required: ['listenMarkdownTestServer('], forbidden: ['keyedServer(', 'answeringServer(', 'listenMarkdownServer('] },
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
