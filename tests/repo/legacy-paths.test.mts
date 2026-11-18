// The files that moved to legacy/ resolve the repository root from their new folder, as they did before the move: each root
// they build from their own location is the root of this repository, and each path they build from it exists (T636).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../testcase.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const missing = (paths: string[]) => paths.filter(path => !existsSync(path));
// captured is group n of a match, which the pattern always captures; a match without it fails the case.
const captured = (match: RegExpMatchArray, n: number): string => {
  const text = match[n];
  assert.ok(text !== undefined, `the match ${match[0]} captures no group ${n}`);
  return text;
};

caseTest('legacy paths: models-scan scans folders that exist', () => {
  const file = 'legacy/packages/ts/tests/models-scan.mjs';
  const up = /^const root = resolve\(client, '([^']+)'\);$/m.exec(read(file))?.[1];
  assert.ok(up !== undefined, `${file} has no root line`);
  const base = resolve(root, 'legacy/packages/ts', up);
  assert.equal(base, root);
  assert.deepEqual(missing([join(base, 'tests/conformance'), join(base, 'examples/thin-slice/ts')]), []);
});

caseTest('legacy paths: dbspec-stress runs a generator that exists', () => {
  const file = 'legacy/packages/ts/tests/dbspec-stress.mjs';
  const up = /^const root = new URL\('([^']+)', import\.meta\.url\);$/m.exec(read(file))?.[1];
  assert.ok(up !== undefined, `${file} has no root line`);
  assert.equal(resolve(root, dirname(file), up), root);
  assert.deepEqual(missing([resolve(root, dirname(file), up, 'tests/dbspec/stress.mts')]), []);
});

caseTest('legacy paths: the Python vectors reader reads schemas that exist', () => {
  const file = 'legacy/packages/python/tests/dbspec_vectors_reader.py';
  const depths = [...read(file).matchAll(/\.parents\[(\d+)\]/g)].map(match => Number(match[1]));
  assert.ok(depths.length > 0, `${file} names no parent`);
  const base = (depth: number) => resolve(root, dirname(file), ...Array<string>(depth).fill('..'));
  assert.deepEqual(depths.map(base), depths.map(() => root));
  assert.deepEqual(missing(depths.flatMap(depth => [join(base(depth), 'tests/dbspec/schema'), join(base(depth), 'scripts/features/schema/recipe.schema.json')])), []);
});

caseTest('legacy paths: every feature command that enters a folder runs a node script that exists', () => {
  const commands = [...read('contracts/features.json').matchAll(/^\s*"command": (".*"),?$/gm)].map(match => JSON.parse(captured(match, 1)) as string);
  const paths = commands.flatMap(command => [...command.matchAll(/cd ([\w./-]+) && .*?node ((?:\.\.\/)+[\w./-]+\.mts)/g)].map(match => resolve(root, captured(match, 1), captured(match, 2))));
  assert.ok(paths.length > 0, 'contracts/features.json has no command that enters a folder');
  assert.deepEqual(missing(paths), []);
});
