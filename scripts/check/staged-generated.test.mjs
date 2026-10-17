// Tests of the staged-file check: each covered pattern refuses, and each named exception and each ordinary path passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatedOffenders } from './staged-generated.mjs';

const refused = [
  'node_modules/x/index.js',
  'packages/ts/node_modules/a.js',
  'vendor/lib.php',
  'vendor-php/x.php',
  '.venv/bin/python',
  'venv/bin/activate',
  'packages/ts/dist/index.js',
  'packages/rust/target/debug/x',
  'packages/python/src/orm.egg-info/PKG-INFO',
  'a/b.vsix',
  'packages/python/__pycache__/m.cpython-313.pyc',
  'x/m.pyc',
  'docs/.vitepress/cache/x.json',
  '.runtime/servers/env',
  'var/tools/mise/shims/composer',
  'bench.test',
];
const allowed = [
  '.kit/kit.lock.json',
  'tests/conformance/fixtures/a.json',
  'scripts/check/staged-generated.mjs',
  'docs/features.md',
  'docs/dbspec.md',
  'packages/go/go.mod',
];

for (const p of refused) {
  test(`refuses a staged generated path: ${p}`, () => {
    assert.deepEqual(generatedOffenders([p]), [p]);
  });
}
for (const p of allowed) {
  test(`allows an ordinary or named path: ${p}`, () => {
    assert.deepEqual(generatedOffenders([p]), []);
  });
}
test('reports only the offending paths of a mixed list', () => {
  assert.deepEqual(generatedOffenders(['docs/dbspec.md', 'node_modules/a.js', '.kit/kit.lock.json']), ['node_modules/a.js']);
});
