import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCoverage, databases, executeCoverage, languages } from './coverage.mjs';

const contract = (kind = 'database') => ({
  features: [{ id: 'sample', status: 'implemented', clients: Object.fromEntries(languages.map(language => [language, 'pass'])),
    coverage: { kind, cases: ['first', 'second'] } }],
});
const complete = (kind = 'database') => {
  const reports = {};
  for (const language of languages) for (const database of kind === 'database' ? databases : ['none']) {
    const report = { feature: 'sample', language, database, success: true,
      cases: ['first', 'second'], results: [{ id: 'first', value_json: '1' }, { id: 'second', value_json: '2' }],
      ...(kind === 'database' ? { state_before: 'digest', state_after: 'digest' } : {}) };
    reports[`sample/${language}/${database}`] = [structuredClone(report), structuredClone(report)];
  }
  return reports;
};
const mutation = (change, kind = 'database') => {
  const manifest = contract(kind);
  const reports = complete(kind);
  change(manifest, reports);
  return checkCoverage(manifest, reports);
};

test('all four languages and three databases with repeated equal results pass', { timeout: 1000 }, () => {
  assert.deepEqual(checkCoverage(contract(), complete()), []);
  assert.deepEqual(checkCoverage(contract('independent'), complete('independent')), []);
});

test('missing implementation claim, test execution, database, case, and repeat are RED', { timeout: 1000 }, () => {
  assert.match(mutation((m) => { m.features[0].clients.rust = 'planned'; }).join('\n'), /lacks a passing client/);
  assert.match(mutation((_, r) => { delete r['sample/php/mysql']; }).join('\n'), /sample\/php\/mysql: no executed report/);
  assert.match(mutation((m) => { m.features[0].coverage.kind = 'independent'; }).join('\n'), /sample\/go\/none: no executed report/);
  assert.match(mutation((_, r) => { r['sample/rust/sqlite'][0].cases = ['first']; }).join('\n'), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/typescript/postgres'].pop(); }).join('\n'), /exactly two executions required/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][0].state_after = 'changed'; }).join('\n'), /database state changed or was not observed/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][1].results[1].value_json = '3'; }).join('\n'), /results changed on repeated execution/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][0].success = false; }).join('\n'), /execution failed/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][0].results[1].id = 'first'; }).join('\n'), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][0].results[1].value_json = '{'; }).join('\n'), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/go/mysql'][1].results[1].value_json = '9007199254740993'; }).join('\n'), /results changed on repeated execution/);
});

test('undeclared feature, language, database, and duplicate cases are RED', { timeout: 1000 }, () => {
  assert.match(mutation((_, r) => { r['other/go/mysql'] = r['sample/go/mysql']; }).join('\n'), /undeclared execution report/);
  assert.match(mutation((_, r) => { r['sample/python/mysql'] = r['sample/go/mysql']; }).join('\n'), /undeclared execution report/);
  assert.match(mutation((_, r) => { r['sample/go/oracle'] = r['sample/go/mysql']; }).join('\n'), /undeclared execution report/);
  assert.match(mutation((m) => { m.features[0].coverage.cases = ['first', 'first']; }).join('\n'), /distinct nonempty IDs/);
});

test('commands execute twice now and a failed or missing command is RED', { timeout: 5000 }, async () => {
  const manifest = contract('independent');
  const output = (language) => JSON.stringify({ feature: 'sample', language, database: 'none', success: true,
    cases: ['first', 'second'], results: [{ id: 'first', value_json: '1' }, { id: 'second', value_json: '2' }] });
  manifest.features[0].coverage.commands = Object.fromEntries(languages.map(language =>
    [language, { none: `node -e 'process.stdout.write(${JSON.stringify(output(language))})'` }]));
  assert.deepEqual(await executeCoverage(manifest, process.cwd(), 1000), []);
  manifest.features[0].coverage.commands.php.none = 'exit 4';
  assert.match((await executeCoverage(manifest, process.cwd(), 1000)).join('\n'), /sample\/php\/none run 1: exit 4/);
  delete manifest.features[0].coverage.commands.rust.none;
  assert.match((await executeCoverage(manifest, process.cwd(), 1000)).join('\n'), /sample\/rust\/none: no executable command/);
});
