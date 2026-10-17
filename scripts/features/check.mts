import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path, { resolve } from 'node:path';
import { COMPUTE, runGroup, sections, stepLines, type Step } from '../../tests/testcase.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';
import type { Check } from './select.mts';
import { manifestInputErrors } from './owners.mts';
import { readFeatures, type FeatureManifest } from './manifest.mts';
import { clientLanguages, unitTests, unknownParityUnits } from './languages.mts';
import { JsonError, readJsonFile, SchemaError } from '../json/schema.mts';
import { parseSelection, selectChecks, selectionErrors, SHARDS } from './select.mts';

const root = resolve(new URL('../..', import.meta.url).pathname);
// 검증 명령 앞의 manifest 검사는 file을 읽고 비교하는 case 하나다.
const log = sections();
log.begin('features/contracts', COMPUTE);
const errors: string[] = [];
// manifest는 schema(scripts/features/schema/features.schema.json)로 읽는다: 모양, 상태 값, 구현된 기능의 test와
// 문서, 검증 명령의 field는 schema가 확인하고, 아래 검사는 schema가 말할 수 없는 것(VERSION, disk의 path, 유일한 id,
// shard, fixture)을 본다. schema가 거부하면 그 오류만 적고 끝낸다.
const manifest = readManifest();
const ids = new Set<string>();
// shardOf는 (cwd, command)마다 그것을 처음 선언한 검증 명령과 그 shard다.
const shardOf = new Map<string, { shard: string; name: string }>();
const clients = clientLanguages();
const VECTORS_SCHEMA = new URL('../../tests/conformance/schema/vectors.schema.json', import.meta.url).pathname;
const FIXTURE_SCHEMA = new URL('./schema/fixture.schema.json', import.meta.url).pathname;
const runVerification = process.argv.includes('--run');
// 고르는 인자는 scripts/features/select.mts가 읽는다. 검사는 고른 것과 무관하게 모든 기능을 본다.
const selection = parseSelection(process.argv);

// execute는 명령의 출력 줄을 실행 중에 step으로 내보낸다. 명령이 실행하는 runner가 case마다
// 시작, 결과, 경과 시간과 기한을 보고한다.
const execute = (command: string, cwd: string, step: Step) => new Promise<{ code: number; output?: string }>((resolveRun) => {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env });
  const lines = stepLines(step);
  child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
  child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
  child.on('error', error => resolveRun({ code: 1, output: error.message }));
  child.on('close', code => { lines.flush(); resolveRun({ code: code ?? 1 }); });
});

function readManifest(): FeatureManifest {
  try {
    return readFeatures(root);
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof JsonError)) throw error;
    const lines = error instanceof SchemaError ? error.lines : [error.message];
    log.end(`${lines.length} error(s); each is listed at the end`);
    for (const line of lines) console.error(`features: ${line}`);
    process.exit(1);
  }
}

const version = (await readFile(resolve(root, 'VERSION'), 'utf8')).trim();
if (manifest.contract_version !== version) errors.push(`contract_version must equal VERSION ${version}`);
for (const relative of manifest.source.read_order) {
  try { await stat(resolve(root, relative)); }
  catch { errors.push(`source.read_order: missing path ${relative}`); }
}
for (const feature of manifest.features) {
  if (ids.has(feature.id)) errors.push(`duplicate feature id: ${feature.id}`);
  ids.add(feature.id);
  if (feature.status !== 'planned') {
    for (const [index, check] of feature.verification.entries()) {
      if (!SHARDS.includes(check.shard)) errors.push(`${feature.id}: verification ${index} declares the shard ${JSON.stringify(check.shard)}; declare one of ${SHARDS.join(', ')}`);
      // 같은 directory의 같은 명령은 한 번만 실행되므로(아래 executed) 그 명령을 선언한 모든 기능이 같은 shard에 있어야 한다.
      const key = JSON.stringify([check.cwd ?? '.', check.command]);
      const first = shardOf.get(key);
      if (first && first.shard !== check.shard) errors.push(`${feature.id}/${check.id}: shard ${check.shard} differs from shard ${first.shard} of ${first.name}, which runs the same command; declare one shard for both`);
      else if (!first) shardOf.set(key, { shard: check.shard, name: `${feature.id}/${check.id}` });
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
      const fixture = readJsonFile<{ feature: string }>(resolve(root, relative), FIXTURE_SCHEMA);
      if (fixture.feature !== feature.id) errors.push(`${feature.id}: fixture ${relative} has a different feature id`);
    } catch (error) {
      if (error instanceof SchemaError) errors.push(...error.lines.map(line => `${feature.id}: ${line}`));
      else errors.push(`${feature.id}: invalid JSON fixture ${relative}: ${errorMessage(error)}`);
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
    // The source and every database expectation are read against the schema of the conformance vectors; their vector
    // names are unique and at least the declared minimum.
    for (const relative of [contract.source, ...contract.database_expectations]) {
      try {
        const names = readJsonFile<{ vectors: { name: string }[] }>(resolve(root, relative), VECTORS_SCHEMA).vectors.map(vector => vector.name);
        if (names.length < contract.minimum_vectors) errors.push(`${feature.id}: ${relative} has ${names.length} vectors, below ${contract.minimum_vectors}`);
        if (new Set(names).size !== names.length) errors.push(`${feature.id}: the vector names of ${relative} are not unique`);
      } catch (error) {
        if (error instanceof SchemaError) errors.push(...error.lines.map(line => `${feature.id}: ${line}`));
        else errors.push(`${feature.id}: ${relative}: ${errorMessage(error)}`);
      }
    }
  }
}

// tests.language-parity (the parity check of @polyspec/kit reads config/parity.json): every language test file belongs to a
// feature. A shared vector contract covers all clients because the conformance comparator fails when one language does not
// run the declared vectors.
const languageTests: Record<string, { roots: string[]; match: (file: string) => boolean }> = {
  // packages/go/testcase is the case harness of every Go test, checked by make testcase-check, not a feature of the client.
  go: { roots: ['packages/go'], match: (file: string) => file.endsWith('_test.go') && !file.startsWith('packages/go/testcase/') },
  php: { roots: ['packages/php/tests', 'tests/interfaces/php.php'], match: () => true },
  rust: { roots: ['packages/rust/orm/tests', 'packages/rust/build/tests', 'packages/rust/tests', 'tests/interfaces/rust'], match: (file: string) => file.endsWith('.rs') && !file.endsWith('build.rs') },
  typescript: { roots: ['packages/ts', 'tests/interfaces/typescript.mts'], match: (file: string) => file.endsWith('.test.ts') || (file.startsWith('packages/ts/tests/') && file.endsWith('.mjs')) },
  python: { roots: ['packages/python/tests', 'tests/interfaces/python.py'], match: (file: string) => file.endsWith('.py') },
};
const skipDirectories = new Set(['node_modules', 'target', 'dist']);
const walk = async (directory: string) => {
  const entries = await readdir(resolve(root, directory), { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.relative(root, resolve(entry.parentPath, entry.name)).split(path.sep).join('/');
    if (!file.split('/').some(part => skipDirectories.has(part))) files.push(file);
  }
  return files;
};
const existing: Record<string, Set<string>> = {};
for (const [language, spec] of Object.entries(languageTests)) {
  const files = new Set<string>();
  for (const directory of spec.roots) {
    try {
      for (const file of await walk(directory)) if (spec.match(file)) files.add(file);
    } catch (error) {
      if (errorCode(error) === 'ENOTDIR') {
        if (spec.match(directory)) files.add(directory);
      } else {
        throw error;
      }
    }
  }
  existing[language] = files;
}
const listedByFeatures = new Set<string>();
for (const feature of manifest.features) {
  for (const relative of [...feature.fixtures, ...feature.tests]) listedByFeatures.add(relative);
}
// helper의 file과 그 unit test도 선언된 test file이다.
for (const helper of manifest.helpers ?? []) for (const relative of [...helper.paths, ...helper.tests]) listedByFeatures.add(relative);
// 검증 명령, coverage 단위, helper는 owner-check가 고를 입력을 선언한다(scripts/features/owners.mts).
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
errors.push(...manifestInputErrors(manifest, tracked));
for (const feature of manifest.features) {
  for (const id of unknownParityUnits(feature.parity)) errors.push(`${feature.id}: parity unit ${id} is not declared in config/parity.json`);
  // Each owner or dependent test of a language is bound by a parity unit of that language that the feature names.
  const parts = [
    ...Object.entries(feature.coverage?.owners ?? {}).map(([language, owner]) => ({ language, tests: owner.tests, role: 'owner' })),
    ...(feature.coverage?.dependents ?? []).map(dependent => ({ language: dependent.language, tests: dependent.tests, role: `dependent ${dependent.id}` })),
  ];
  for (const { language, tests, role } of parts) {
    if (!clients.includes(language)) continue;
    const bound = feature.parity.some(id => unitTests(id, language).some(test => tests.includes(test)));
    if (!bound) errors.push(`${feature.id}: the ${role} of ${language} is bound by no parity unit of that feature`);
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
  const executed = new Map<string, { name: string; done: Promise<boolean> }>();
  // environment linux-runner인 명령은 선언된 Linux runner(.github/runner)의 검사다: CI가
  // 그 runner의 Linux에서 make check로 실행한다. Linux가 아닌
  // machine에서는 실행하지 않고 그 사실을 RUNNER 줄로 출력한다. 통과로 세지 않는다.
  const runner = (await readFile(resolve(root, '.github/runner'), 'utf8')).trim();
  const verify = async ({ feature, check }: { feature: { id: string }; check: Check & { environment?: string } }) => {
    const name = `features/${feature.id}/${check.id}`;
    if (check.environment === 'linux-runner' && process.platform !== 'linux') {
      console.log(`RUNNER ${name}: ${check.command} runs on the Linux runner ${runner}; CI runs it there`);
      return;
    }
    const key = JSON.stringify([check.cwd ?? '.', check.command]);
    const previous = executed.get(key);
    let settle: ((passed: boolean) => void) | undefined;
    if (!previous) executed.set(key, { name, done: new Promise<boolean>(resolveDone => { settle = resolveDone; }) });
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
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await verify(next);
  }));
}

if (errors.length) {
  for (const error of errors) console.error(`features: ${error}`);
  process.exit(1);
}
console.log(`features: ${manifest.features.length} feature contracts passed`);
