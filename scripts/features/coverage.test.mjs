import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCoverage, databases, executeCoverage, languages } from './coverage.mjs';

const ownerTests = {
  go: 'clients/go/orm/dsn_test.go', php: 'clients/php/tests/dsn.php',
  rust: 'clients/rust/orm/tests/zone.rs', typescript: 'clients/typescript/tests/typecheck.ts',
};
const consumerTest = 'clients/go/model/model_test.go';

function contract(kind = 'database') {
  return { features: [{ id: 'sample', status: 'implemented',
    clients: Object.fromEntries(languages.map(language => [language, 'pass'])),
    coverage: { kind, cases: ['first', 'second'],
      owners: Object.fromEntries(languages.map(language => [language, { part: `clients/${language}`,
        tests: [ownerTests[language]], commands: {} }])),
      consumers: [{ id: 'service', language: 'go', part: 'clients/go/model',
        tests: [consumerTest], cases: ['first'], commands: {} }] } }] };
}

function complete(kind = 'database') {
  const reports = {};
  const make = (role, part, tests, language, database, cases, consumer) => {
    const report = { feature: 'sample', role, part, tests, language, database, success: true, cases,
      results: cases.map((id, index) => ({ id, value_json: String(index + 1) })),
      ...(consumer ? { consumer } : {}),
      ...(kind === 'database' ? { state_before: 'digest', state_after: 'digest' } : {}) };
    return [structuredClone(report), structuredClone(report)];
  };
  for (const language of languages) for (const database of kind === 'database' ? databases : ['none']) {
    reports[`sample/owner/${language}/${database}`] = make('owner', `clients/${language}`, [ownerTests[language]], language, database, ['first', 'second']);
    if (language === 'go') reports[`sample/consumer/service/go/${database}`] = make('consumer', 'clients/go/model', [consumerTest], language, database, ['first'], 'service');
  }
  return reports;
}

function mutation(change, kind = 'database') {
  const manifest = contract(kind);
  const reports = complete(kind);
  change(manifest, reports);
  return checkCoverage(manifest, reports).join('\n');
}

test('owner and consumer cases execute in four languages and three databases', { timeout: 1000 }, () => {
  assert.deepEqual(checkCoverage(contract(), complete()), []);
  assert.deepEqual(checkCoverage(contract('independent'), complete('independent')), []);
});

test('missing owner, consumer, database, case, and repeat are RED', { timeout: 1000 }, () => {
  assert.match(mutation((m) => { m.features[0].coverage.owners.rust = undefined; }), /sample\/owner\/rust: missing owning client part/);
  assert.match(mutation((_, r) => { delete r['sample/owner/php/mysql']; }), /sample\/owner\/php\/mysql: no executed report/);
  assert.match(mutation((_, r) => { delete r['sample/consumer/service/go/mysql']; }), /sample\/consumer\/service\/go\/mysql: no executed report/);
  assert.match(mutation((m) => { delete m.features[0].coverage.consumers; }), /missing consumers declaration/);
  assert.match(mutation((m) => { m.features[0].coverage.consumers[0].part = 'clients/go'; }), /invalid consuming part/);
  assert.match(mutation((m) => { m.features[0].coverage.consumers[0].cases = []; }), /invalid consuming part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.rust.tests = ['tests/conformance/check/main_test.go']; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.go.tests = [consumerTest]; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { m.features[0].coverage.consumers[0].tests = [ownerTests.go]; }), /invalid consuming part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.consumers[0].tests = ['tests/conformance/check/main_test.go']; }), /invalid consuming part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.consumers[0].part = 'tests/conformance'; m.features[0].coverage.consumers[0].tests = ['tests/conformance/check/main_test.go']; }), /invalid consuming part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.python = { part: 'clients/python', tests: [], commands: {} }; }), /undeclared owning client/);
  assert.match(mutation((_, r) => { r['sample/consumer/service/go/sqlite'][0].cases = []; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/owner/typescript/postgres'].pop(); }), /exactly two executions required/);
});

test('identity, result, state, and unknown report mutations are RED', { timeout: 1000 }, () => {
  assert.match(mutation((m) => { m.features[0].clients.rust = 'planned'; }), /lacks a passing client/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].part = 'clients/php'; }), /report identity differs/);
  assert.match(mutation((_, r) => { r['sample/consumer/service/go/mysql'][0].role = 'owner'; }), /report identity differs/);
  assert.match(mutation((_, r) => { r['sample/consumer/service/go/mysql'][0].tests = [ownerTests.go]; }), /executed test paths differ/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].success = false; }), /execution failed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].state_after = 'changed'; }), /database state changed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][1].results[1].value_json = '9007199254740993'; }), /results changed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].results[1].id = 'first'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].results[1].value_json = '{'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['other/owner/go/mysql'] = r['sample/owner/go/mysql']; }), /undeclared execution report/);
  assert.match(mutation((m) => { m.features[0].coverage.cases = ['first', 'first']; }), /distinct nonempty IDs/);
});

test('owner and consumer commands run twice from their own parts', { timeout: 8000 }, async () => {
  const manifest = contract('independent');
  const output = (role, part, tests, language, cases, consumer) => JSON.stringify({ feature: 'sample', role, part, tests, language,
    database: 'none', success: true, cases, results: cases.map((id, index) => ({ id, value_json: String(index + 1) })),
    ...(consumer ? { consumer } : {}) });
  for (const language of languages) manifest.features[0].coverage.owners[language].commands.none =
    `node -e 'process.stdout.write(${JSON.stringify(output('owner', `clients/${language}`, [ownerTests[language]], language, ['first', 'second']))})'`;
  manifest.features[0].coverage.consumers[0].commands.none =
    `node -e 'process.stdout.write(${JSON.stringify(output('consumer', 'clients/go/model', [consumerTest], 'go', ['first'], 'service'))})'`;
  const root = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(await executeCoverage(manifest, root, 1000), []);
  manifest.features[0].coverage.owners.php.commands.none = 'exit 4';
  assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /sample\/owner\/php\/none run 1: exit 4/);
  delete manifest.features[0].coverage.consumers[0].commands.none;
  assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /sample\/consumer\/service\/go\/none: no executable command/);
  manifest.features[0].coverage.owners.rust.tests = ['clients/rust/orm/tests/missing_test.rs'];
  assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /sample\/owner\/rust\/none: unavailable part directory/);
});
