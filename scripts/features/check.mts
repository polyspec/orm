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
// The manifest check before the verify command is one case that reads a file and compares it.
const log = sections();
log.begin('features/contracts', COMPUTE);
const errors: string[] = [];
// The manifest is read with the schema (scripts/features/schema/features.schema.json): its shape, status values, and the tests of implemented features,
// the doc and verify-command fields are checked by the schema, and the checks below look at what the schema cannot say (VERSION, the path on disk, unique ids,
// shards, fixtures). If the schema rejects, it reports only that error and stops.
const manifest = readManifest();
const ids = new Set<string>();
// shardOf is, for each (cwd, command), the verify command that first declared it and its shard.
const shardOf = new Map<string, { shard: string; name: string }>();
const clients = clientLanguages();
const VECTORS_SCHEMA = new URL('../../tests/conformance/schema/vectors.schema.json', import.meta.url).pathname;
const FIXTURE_SCHEMA = new URL('./schema/fixture.schema.json', import.meta.url).pathname;
const runVerification = process.argv.includes('--run');
// The selecting arguments are read by scripts/features/select.mts. The check looks at all features regardless of the selection.
const selection = parseSelection(process.argv);

// execute reports the command's output lines as steps while it runs. The runner that the command runs for each case
// reports the start, result, elapsed time, and deadline.
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
      // The same command in the same directory runs only once (executed below), so all features that declare that command must be in the same shard.
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
  php: { roots: ['packages/php/tests', 'packages/php/testing/interfaces/php.php'], match: () => true },
  rust: { roots: ['packages/rust/orm/tests', 'packages/rust/build/tests', 'packages/rust/tests', 'packages/rust/testing/interfaces'], match: (file: string) => file.endsWith('.rs') && !file.endsWith('build.rs') },
  typescript: { roots: ['packages/ts', 'packages/ts/testing/interfaces/typescript.mts'], match: (file: string) => file.endsWith('.test.ts') || (file.startsWith('packages/ts/tests/') && file.endsWith('.mjs')) },
  python: { roots: ['packages/python/tests', 'packages/python/testing/interfaces/python.py'], match: (file: string) => file.endsWith('.py') },
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
// The helper's file and its unit test are also declared test files.
for (const helper of manifest.helpers ?? []) for (const relative of [...helper.paths, ...helper.tests]) listedByFeatures.add(relative);
// Verify commands, coverage units, and helpers declare the inputs that owner-check will select (scripts/features/owners.mts).
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
  // Verify commands are independent of each other (a test that uses a database makes its own database for each case). So
  // they run together with ORM_FEATURE_LANES (default 4). A generation check that rewrites a tracked file (go-model-check)
  // is a target of make check, not a verify command.
  // When several features verify with the same command in the same directory (decimal, styled value, engine checks),
  // the command runs only once, the first time, and the next feature reports that run's result as its own. The same
  // command run again in the same tree only does the same work again.
  const lanes = Number(process.env.ORM_FEATURE_LANES ?? 4);
  if (!(Number.isInteger(lanes) && lanes > 0)) throw new Error(`ORM_FEATURE_LANES ${process.env.ORM_FEATURE_LANES} is not a positive integer`);
  const checks = selectChecks(manifest, selection);
  const executed = new Map<string, { name: string; done: Promise<boolean> }>();
  // A command whose environment is linux-runner is a check of the declared Linux runner (.github/runner): CI
  // runs make check on that runner's Linux.
  // On a machine that is not Linux, it does not run and prints that fact as a RUNNER line. It is not counted as a pass.
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
