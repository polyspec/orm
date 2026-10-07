import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path, { resolve } from 'node:path';
import { COMPUTE, runGroup, sections, stepLines } from '../../tests/testcase.mjs';
import { manifestInputErrors } from './owners.mjs';
import { parseSelection, selectChecks, selectionErrors, SHARDS } from './select.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifestPath = resolve(root, 'contracts/features.json');
// 검증 명령 앞의 manifest 검사는 file을 읽고 비교하는 case 하나다.
const log = sections();
log.begin('features/contracts', COMPUTE);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];
const ids = new Set();
const statuses = new Set(['planned', 'partial', 'implemented']);
// shardOf는 (cwd, command)마다 그것을 처음 선언한 검증 명령과 그 shard다.
const shardOf = new Map();
const clientStatuses = new Set(['planned', 'partial', 'pass', 'unsupported']);
const clients = ['go', 'php', 'rust', 'typescript'];
const databases = ['mysql', 'postgres', 'sqlite'];
const runVerification = process.argv.includes('--run');
// 고르는 인자는 scripts/features/select.mjs가 읽는다. 검사는 고른 것과 무관하게 모든 기능을 본다.
const selection = parseSelection(process.argv);

// execute는 명령의 출력 줄을 실행 중에 step으로 내보낸다. 명령이 실행하는 runner가 case마다
// 시작, 결과, 경과 시간과 기한을 보고한다.
const execute = (command, cwd, step) => new Promise((resolveRun) => {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env });
  const lines = stepLines(step);
  child.stdout.on('data', chunk => lines.write(String(chunk)));
  child.stderr.on('data', chunk => lines.write(String(chunk)));
  child.on('error', error => resolveRun({ code: 1, output: error.message }));
  child.on('close', code => { lines.flush(); resolveRun({ code: code ?? 1 }); });
});

if (manifest.manifest_version !== 1) errors.push('manifest_version must be 1');
const version = (await readFile(resolve(root, 'VERSION'), 'utf8')).trim();
if (manifest.contract_version !== version) errors.push(`contract_version must equal VERSION ${version}`);
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
      if (Object.keys(check).some(key => !['id', 'command', 'shard', 'inputs', 'cwd', 'environment'].includes(key))) errors.push(`${feature.id}: verification ${index} has a field other than id, command, shard, inputs, cwd and environment`);
      if (!SHARDS.includes(check.shard)) errors.push(`${feature.id}: verification ${index} declares the shard ${JSON.stringify(check.shard)}; declare one of ${SHARDS.join(', ')}`);
      // 같은 directory의 같은 명령은 한 번만 실행되므로(아래 executed) 그 명령을 선언한 모든 기능이 같은 shard에 있어야 한다.
      const key = JSON.stringify([check.cwd ?? '.', check.command]);
      const first = shardOf.get(key);
      if (first && first.shard !== check.shard) errors.push(`${feature.id}/${check.id}: shard ${check.shard} differs from shard ${first.shard} of ${first.name}, which runs the same command; declare one shard for both`);
      else if (!first) shardOf.set(key, { shard: check.shard, name: `${feature.id}/${check.id}` });
      if (check.environment !== undefined && check.environment !== 'linux-runner') errors.push(`${feature.id}: verification ${index} environment must be linux-runner`);
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
  go: { roots: ['clients/go', 'engine', 'generator', 'cmd'], match: file => file.endsWith('_test.go') },
  php: { roots: ['clients/php/tests', 'tests/interfaces/php.php'], match: () => true },
  rust: { roots: ['clients/rust/orm/tests', 'clients/rust/orm-build/tests', 'clients/rust/tests', 'tests/interfaces/rust'], match: file => file.endsWith('.rs') && !file.endsWith('build.rs') },
  typescript: { roots: ['clients/typescript', 'tests/interfaces/typescript.mjs'], match: file => file.endsWith('.test.ts') || (file.startsWith('clients/typescript/tests/') && file.endsWith('.mjs')) },
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
// helper의 file과 그 unit test도 선언된 test file이다.
for (const helper of manifest.helpers ?? []) for (const relative of [...(helper.paths ?? []), ...(helper.tests ?? [])]) listedByFeatures.add(relative);
// 검증 명령, coverage 단위, helper는 owner-check가 고를 입력을 선언한다(scripts/features/owners.mjs).
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
errors.push(...manifestInputErrors(manifest, tracked));
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

errors.push(...selectionErrors(manifest, selection));
log.end(errors.length ? `${errors.length} error(s); each is listed at the end` : undefined);
if (runVerification && errors.length === 0) {
  // 검증 명령은 서로 독립이다(database를 쓰는 test는 case마다 자기 database를 만든다). 그래서
  // ORM_FEATURE_LANES개(기본 4)를 함께 실행한다. 추적되는 file을 다시 쓰는 생성 검사(go-model-check)는
  // 검증 명령이 아니라 make check의 target이다.
  // 여러 기능이 같은 directory에서 같은 명령으로 검증하면(decimal, styled value, engine 검사)
  // 명령은 처음 한 번만 실행하고, 다음 기능은 그 실행의 결과를 자기 결과로 보고한다. 같은
  // 명령을 같은 tree에서 다시 실행해도 같은 일을 다시 할 뿐이다.
  const lanes = Number(process.env.ORM_FEATURE_LANES ?? 4);
  if (!(Number.isInteger(lanes) && lanes > 0)) throw new Error(`ORM_FEATURE_LANES ${process.env.ORM_FEATURE_LANES} is not a positive integer`);
  const checks = selectChecks(manifest, selection);
  const executed = new Map();
  // environment linux-runner인 명령은 선언된 Linux runner(.github/runner)의 검사다: CI가
  // 그 runner의 Linux에서 make check로 실행한다. Linux가 아닌
  // machine에서는 실행하지 않고 그 사실을 RUNNER 줄로 출력한다. 통과로 세지 않는다.
  const runner = (await readFile(resolve(root, '.github/runner'), 'utf8')).trim();
  const verify = async ({ feature, check }) => {
    const name = `features/${feature.id}/${check.id}`;
    if (check.environment === 'linux-runner' && process.platform !== 'linux') {
      console.log(`RUNNER ${name}: ${check.command} runs on the Linux runner ${runner}; CI runs it there`);
      return;
    }
    const key = JSON.stringify([check.cwd ?? '.', check.command]);
    const previous = executed.get(key);
    let settle;
    if (!previous) executed.set(key, { name, done: new Promise(resolveDone => { settle = resolveDone; }) });
    const passed = await runGroup(name, async ({ step }) => {
      step(check.command);
      if (previous) {
        step(`the same command runs as ${previous.name}`);
        if (!(await previous.done)) throw new Error(`${previous.name} failed`);
        return;
      }
      const result = await execute(check.command, resolve(root, check.cwd ?? '.'), step);
      if (result.code !== 0) throw new Error(`command exited ${result.code}${result.output ? `: ${result.output}` : ''}`);
    });
    if (settle) settle(passed);
    if (!passed) errors.push(`${feature.id}/${check.id}: command failed; its output is in the STEP lines above`);
  };
  const queue = [...checks];
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (queue.length > 0) await verify(queue.shift());
  }));
}

if (errors.length) {
  for (const error of errors) console.error(`features: ${error}`);
  process.exit(1);
}
console.log(`features: ${manifest.features.length} feature contracts passed`);
