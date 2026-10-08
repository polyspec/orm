// Tests of the behaviors that the dependency tools take from the implementations they replace: npm range satisfaction and
// duplicate detection, the packages of an npm workspace and a tagged package, the Composer platform and the exact pin of a
// Python requirement. Each runs on a copy of tests/kit/fixture, so no test uses the network.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { npmDuplicates, npmSatisfies, pythonRequirements } from '../../scripts/kit/dependency-state.mjs';
import { fixtureCheckout as fixture, gate } from './checkout.mjs';

const edit = (root, file, change) => {
  const data = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  change(data);
  writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
};
const findings = result => result.stderr.split('\n').filter(line => line.startsWith('[dependency-policy] ') && !line.includes(' finding'));

test('an npm version satisfies a range by the rules of npm', () => {
  assert.equal(npmSatisfies('1.2.3', '^1.0.0'), true);
  assert.equal(npmSatisfies('2.0.0', '^1.0.0'), false);
  assert.equal(npmSatisfies('1.2.9', '~1.2.3'), true);
  assert.equal(npmSatisfies('1.3.0', '~1.2.3'), false);
  assert.equal(npmSatisfies('1.5.0', '1.2.x || >=1.4.0 <2.0.0'), true);
  assert.equal(npmSatisfies('3.0.0-rc.1', '>=2.0.0'), false);
  assert.equal(npmSatisfies('3.0.0-rc.1', '>=3.0.0-rc.0'), true);
  assert.equal(npmSatisfies('not a version', '^1.0.0'), null);
});

test('a package installed at two versions that one version satisfies is reported once', () => {
  const lock = { packages: {
    '': { dependencies: { left: '^1.0.0', right: '^1.0.0' } },
    'node_modules/left': { version: '1.1.0', dependencies: { shared: '^1.0.0' } },
    'node_modules/right': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
    'node_modules/shared': { version: '1.2.0' },
    'node_modules/right/node_modules/shared': { version: '1.0.5' },
  } };
  const lines = npmDuplicates(lock);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /shared/);
});

test('the gate fails when a workspace package has another version than its lock entry', (t) => {
  const root = fixture(t);
  edit(root, 'packages/fixture-lib/package.json', (manifest) => { manifest.version = '0.0.1'; });
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith('[dependency-policy] packages/fixture-app/package.json fixture-lib: the manifest requires 0.0.0, packages/fixture-lib has version 0.0.1')), result.stderr);
});

test('the gate fails when a tagged package has another version than its tag, and prints the fix of the policy', (t) => {
  const root = fixture(t);
  edit(root, 'vendor/tagged/js/package.json', (manifest) => { manifest.version = '9.9.9'; });
  const result = gate(root);
  assert.equal(result.status, 1);
  const line = findings(result).find(item => item.includes('tagged-lib'));
  assert.ok(line, result.stderr);
  assert.match(line, /vendor\/tagged\/js has version 9\.9\.9, the tag v1\.2\.3 has version 1\.2\.3\. Rule: .+\. Fix: make install-tagged\.$/);
});

test('the gate fails when the Composer platform of a manifest is not the policy minimum', (t) => {
  const root = fixture(t);
  edit(root, 'packages/fixture-php/composer.json', (manifest) => { manifest.config.platform.php = '8.1.0'; });
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith('[dependency-policy] packages/fixture-php/composer.json: config.platform.php is 8.1.0, the policy declares 8.2.0')), result.stderr);
});

test('a Python requirement is pinned exactly, in the build system and in each extra', () => {
  const text = '[build-system]\nrequires = ["setuptools==84.0.0"]\n\n[project.optional-dependencies]\ndev = ["ruff==0.16.10"]\ndocs = ["mkdocs==1.6.1"]\n';
  assert.deepEqual(pythonRequirements(text, 'pyproject.toml').map(item => [item.package, item.kind, item.version]), [
    ['setuptools', 'build-system', '84.0.0'], ['ruff', 'optional:dev', '0.16.10'], ['mkdocs', 'optional:docs', '1.6.1'],
  ]);
  assert.throws(() => pythonRequirements('[build-system]\nrequires = ["setuptools>=80"]\n', 'pyproject.toml'), /"setuptools>=80" is not an exact pin name==version; pin it exactly/);
});
