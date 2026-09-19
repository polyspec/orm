import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path, { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifestPath = resolve(root, 'contracts/features.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();
const statuses = new Set(['planned', 'partial', 'implemented']);
const clientStatuses = new Set(['planned', 'partial', 'pass', 'unsupported']);
const clients = ['go', 'php', 'rust', 'typescript'];
const databases = ['mysql', 'postgres', 'sqlite'];
const runVerification = process.argv.includes('--run');

const execute = (command, cwd) => new Promise((resolveRun) => {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => resolveRun({ code: 1, output: error.message }));
  child.on('close', code => resolveRun({ code: code ?? 1, output }));
});

if (manifest.manifest_version !== 1) errors.push('manifest_version must be 1');
if (manifest.contract_version !== '0.0.1') errors.push('contract_version must remain 0.0.1');
if (!Array.isArray(manifest.source?.read_order) || manifest.source.read_order.length === 0) errors.push('source.read_order must be non-empty');
for (const relative of manifest.source?.read_order ?? []) {
  try { await stat(resolve(root, relative)); }
  catch { errors.push(`source.read_order: missing path ${relative}`); }
}
if (!Array.isArray(manifest.features) || manifest.features.length === 0) errors.push('features must be non-empty');

for (const feature of manifest.features ?? []) {
  if (!feature.id || ids.has(feature.id)) errors.push(`duplicate or missing feature id: ${feature.id ?? '<empty>'}`);
  ids.add(feature.id);
  for (const field of ['title', 'title_ko', 'description', 'description_ko', 'inputs', 'outputs', 'state', 'errors', 'clients', 'fixtures', 'tests', 'docs', 'verification']) {
    if (feature[field] === undefined) errors.push(`${feature.id}: missing ${field}`);
  }
  if (!statuses.has(feature.status)) errors.push(`${feature.id}: invalid status ${feature.status}`);
  for (const client of clients) {
    if (!clientStatuses.has(feature.clients?.[client])) errors.push(`${feature.id}: invalid ${client} status`);
  }
  if (feature.status === 'implemented') {
    if (feature.tests.length === 0) errors.push(`${feature.id}: implemented feature has no tests`);
    if (feature.docs.length === 0) errors.push(`${feature.id}: implemented feature has no docs`);
  }
  if (feature.status !== 'planned') {
    if (!Array.isArray(feature.verification) || feature.verification.length === 0) {
      errors.push(`${feature.id}: non-planned feature has no verification commands`);
    }
    for (const [index, check] of (feature.verification ?? []).entries()) {
      if (!check.id || !check.command) errors.push(`${feature.id}: verification ${index} is incomplete`);
    }
  }
  for (const relative of [...feature.fixtures, ...feature.tests, ...feature.docs]) {
    if (relative.includes('*')) continue;
    try { await stat(resolve(root, relative)); }
    catch { errors.push(`${feature.id}: missing path ${relative}`); }
  }
  for (const relative of feature.fixtures) {
    if (!relative.startsWith('contracts/fixtures/') || !relative.endsWith('.json')) continue;
    try {
      const fixture = JSON.parse(await readFile(resolve(root, relative), 'utf8'));
      if (fixture.feature !== feature.id) errors.push(`${feature.id}: fixture ${relative} has a different feature id`);
      if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) errors.push(`${feature.id}: fixture ${relative} has no cases`);
      for (const testCase of fixture.cases ?? []) {
        if (!testCase.id || !testCase.operation || !testCase.expected) errors.push(`${feature.id}: fixture ${relative} has an incomplete case`);
      }
    } catch (error) {
      errors.push(`${feature.id}: invalid JSON fixture ${relative}: ${error.message}`);
    }
  }
  for (const doc of feature.docs) {
    if (!doc.endsWith('.md')) continue;
    const korean = doc.replace(/\.md$/, '.ko.md');
    try { await readFile(resolve(root, korean)); }
    catch { errors.push(`${feature.id}: missing Korean document ${korean}`); }
  }
  if (feature.vector_contract) {
    const contract = feature.vector_contract;
    if (contract.source !== 'tests/conformance/vectors.json') errors.push(`${feature.id}: vector_contract source must be the canonical vector file`);
    if (JSON.stringify(contract.required_clients) !== JSON.stringify(clients)) errors.push(`${feature.id}: vector_contract required_clients must list all clients in canonical order`);
    if (JSON.stringify(contract.required_databases) !== JSON.stringify(databases)) errors.push(`${feature.id}: vector_contract required_databases must list all databases in canonical order`);
    if (!Array.isArray(contract.database_expectations) || contract.database_expectations.length !== databases.length) errors.push(`${feature.id}: vector_contract must provide one expectation file per database`);
    for (const relative of contract.database_expectations ?? []) {
      try { await stat(resolve(root, relative)); }
      catch { errors.push(`${feature.id}: missing vector expectation file ${relative}`); }
    }
    try {
      const vectors = JSON.parse(await readFile(resolve(root, contract.source), 'utf8')).vectors;
      const names = vectors.map(vector => vector.name);
      if (names.length < contract.minimum_vectors) errors.push(`${feature.id}: vector count ${names.length} is below ${contract.minimum_vectors}`);
      if (names.some(name => !name) || new Set(names).size !== names.length) errors.push(`${feature.id}: vector names must be non-empty and unique`);
    } catch (error) {
      errors.push(`${feature.id}: invalid vector contract source: ${error.message}`);
    }
  }
}

// tests.language-parity: every client claim names a test of that language and
// every language test file belongs to a feature. A shared vector contract
// covers all clients because the conformance comparator fails when one
// language does not run the declared vectors.
const languageTests = {
  go: { roots: ['clients/go', 'engine', 'internal', 'cmd', 'bench/go'], match: file => file.endsWith('_test.go') },
  php: { roots: ['clients/php/tests', 'tests/interfaces/php.php'], match: () => true },
  rust: { roots: ['clients/rust/orm/tests', 'clients/rust/orm-build/tests', 'clients/rust/tests', 'tests/interfaces/rust'], match: file => file.endsWith('.rs') && !file.endsWith('build.rs') },
  typescript: { roots: ['clients/typescript', 'tests/typescript', 'tests/interfaces/typescript.mjs'], match: file => file.endsWith('.test.ts') || (file.startsWith('tests/typescript/') && file.endsWith('.mjs')) },
};
const skipDirectories = new Set(['node_modules', 'target', 'dist']);
const walk = async directory => {
  const entries = await readdir(resolve(root, directory), { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parts = entry.parentPath ? [entry.parentPath, entry.name] : [entry.path, entry.name];
    const file = path.relative(root, resolve(...parts)).split(path.sep).join('/');
    if (!file.split('/').some(part => skipDirectories.has(part))) files.push(file);
  }
  return files;
};
const existing = {};
for (const [language, spec] of Object.entries(languageTests)) {
  const files = new Set();
  for (const directory of spec.roots) {
    try {
      for (const file of await walk(directory)) if (spec.match(file)) files.add(file);
    } catch (error) {
      if (error.code === 'ENOTDIR') {
        if (spec.match(directory)) files.add(directory);
      } else {
        throw error;
      }
    }
  }
  existing[language] = files;
}
const claimsLanguage = (language, relative) => languageTests[language].roots.some(directory => relative === directory || relative.startsWith(directory + '/'));
const listedByFeatures = new Set();
for (const feature of manifest.features ?? []) {
  for (const relative of [...(feature.fixtures ?? []), ...(feature.tests ?? [])]) listedByFeatures.add(relative);
}
for (const feature of manifest.features ?? []) {
  for (const language of clients) {
    const status = feature.clients[language];
    const backed = feature.tests.some(relative => claimsLanguage(language, relative)) || Boolean(feature.vector_contract);
    if ((status === 'pass' || status === 'partial') && !backed) errors.push(`${feature.id}: clients.${language} ${status} names no test of that language`);
    if (feature.status === 'implemented' && status !== 'pass') errors.push(`${feature.id}: implemented feature is not pass in ${language}`);
  }
}
for (const [language, files] of Object.entries(existing)) {
  for (const file of files) if (!listedByFeatures.has(file)) errors.push(`${file}: ${language} test file belongs to no feature`);
}

if (runVerification && errors.length === 0) {
  for (const feature of manifest.features ?? []) {
    for (const check of feature.verification ?? []) {
      console.log(`features: run ${feature.id}/${check.id}: ${check.command}`);
      const result = await execute(check.command, resolve(root, check.cwd ?? '.'));
      if (result.code !== 0) {
        errors.push(`${feature.id}/${check.id}: command exited ${result.code}\n${result.output.trim()}`);
      }
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`features: ${error}`);
  process.exit(1);
}
console.log(`features: ${manifest.features.length} feature contracts passed`);
