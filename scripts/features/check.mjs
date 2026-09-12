import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifestPath = resolve(root, 'contracts/features.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();
const statuses = new Set(['planned', 'partial', 'implemented']);
const clientStatuses = new Set(['planned', 'partial', 'pass', 'unsupported']);
const clients = ['go', 'php', 'rust', 'typescript'];

if (manifest.manifest_version !== 1) errors.push('manifest_version must be 1');
if (manifest.contract_version !== '0.0.1') errors.push('contract_version must remain 0.0.1');
if (!Array.isArray(manifest.features) || manifest.features.length === 0) errors.push('features must be non-empty');

for (const feature of manifest.features ?? []) {
  if (!feature.id || ids.has(feature.id)) errors.push(`duplicate or missing feature id: ${feature.id ?? '<empty>'}`);
  ids.add(feature.id);
  for (const field of ['title', 'title_ko', 'description', 'description_ko', 'inputs', 'outputs', 'state', 'errors', 'clients', 'fixtures', 'tests', 'docs']) {
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
  for (const relative of [...feature.fixtures, ...feature.tests, ...feature.docs]) {
    if (relative.includes('*')) continue;
    try { await stat(resolve(root, relative)); }
    catch { errors.push(`${feature.id}: missing path ${relative}`); }
  }
  for (const doc of feature.docs) {
    if (!doc.endsWith('.md')) continue;
    const korean = doc.replace(/\.md$/, '.ko.md');
    try { await readFile(resolve(root, korean)); }
    catch { errors.push(`${feature.id}: missing Korean document ${korean}`); }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`features: ${error}`);
  process.exit(1);
}
console.log(`features: ${manifest.features.length} feature contracts passed`);
