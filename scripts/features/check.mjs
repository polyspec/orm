import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifestPath = resolve(root, 'contracts/features.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();
const statuses = new Set(['planned', 'partial', 'implemented']);
const clientStatuses = new Set(['planned', 'partial', 'pass', 'unsupported']);
const clients = ['go', 'php', 'rust', 'typescript'];
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
