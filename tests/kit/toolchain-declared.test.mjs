// Tests of the toolchain configuration: the schema accepts each representative shape and names a wrong value, and
// declaredToolchain reads every declaring file and fails with the file, the expected form and the actual value.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from '../../scripts/kit/schema-validate.mjs';
import { declaredToolchain } from '../../scripts/kit/toolchain-declared.mjs';
import { FIXTURE_CONFIG, fixtureConfig, toolchainCheckout } from './toolchain-checkout.mjs';

const SCHEMA = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit/schema/toolchain.schema.json'), 'utf8'));
const DIGEST = 'a'.repeat(128);

test('the schema accepts every representative toolchain configuration', () => {
  const names = readdirSync(FIXTURE_CONFIG).filter(name => name.startsWith('toolchain-'));
  assert.deepEqual(names, ['toolchain-composer-digest.json', 'toolchain-files-only.json', 'toolchain-full.json', 'toolchain-go-file.json']);
  for (const name of names) assert.deepEqual(validate(JSON.parse(fixtureConfig(name)), SCHEMA), [], name);
});

test('the schema names an unknown key, a wrong shape and a malformed version', () => {
  const errors = validate({ schema: 1, extra: 1, php: '8.5', composer: '2.10.3', go: {}, cargoAudit: '0.22', python: '3', node: { 'windows.zip': 'x' } }, SCHEMA);
  assert.deepEqual(errors, [
    '$.extra is not in the schema',
    '$.php is string, the schema requires array',
    '$.composer is string, the schema requires object',
    '$.go lacks mod, the schema requires it',
    '$.cargoAudit is "0.22", the schema requires a match of ^\\d+\\.\\d+\\.\\d+$',
    '$.python is "3", the schema requires a match of ^\\d+\\.\\d+$',
    '$.node.windows.zip is not in the schema',
  ]);
});

test('declaredToolchain reads each declaring file of the full shape', (t) => {
  const root = toolchainCheckout(t, {
    'config/toolchain.json': fixtureConfig('toolchain-full.json'),
    '.node-version': '26.8.1\n',
    '.python-version': '3.14\n',
    'package.json': JSON.stringify({ packageManager: `npm@12.2.0+sha512.${DIGEST}` }),
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.98.1"\nprofile = "minimal"\n',
    'packages/fixture-go/go.mod': 'module example.com/fixture\n\ngo 1.27.1\n',
    'packages/fixture-python/pyproject.toml': '[project.optional-dependencies]\ndev = ["ruff==0.16.10"]\n',
  });
  assert.deepEqual(declaredToolchain(root), {
    node: { version: '26.8.1', source: '.node-version' },
    npm: { version: '12.2.0', sha512: DIGEST, source: 'packageManager of package.json' },
    go: { version: '1.27.1', source: 'packages/fixture-go/go.mod go directive' },
    rust: { version: '1.98.1', source: 'rust-toolchain.toml channel' },
    php: { minors: ['8.2', '8.5'], source: 'config/toolchain.json php' },
    python: { minor: '3.14', source: 'config/toolchain.json python' },
    composer: { version: '2.10.3', sha256: undefined, source: 'config/toolchain.json composer' },
    ruff: { version: '0.16.10', source: 'packages/fixture-python/pyproject.toml ruff pin' },
    cargoAudit: { version: '0.22.2', source: 'config/toolchain.json cargoAudit' },
    govulncheck: { version: '1.1.4', source: 'config/toolchain.json govulncheck' },
  });
});

test('declaredToolchain reads the version files when the configuration lists nothing', (t) => {
  const root = toolchainCheckout(t, { '.php-version': '8.5\n', '.python-version': '3.14\n', 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  assert.deepEqual(declaredToolchain(root), {
    npm: { version: '12.2.0', sha512: undefined, source: 'packageManager of package.json' },
    php: { minors: ['8.5'], source: '.php-version' },
    python: { minor: '3.14', source: '.python-version' },
  });
});

test('the Go release comes from the version file, else the toolchain line, else the go directive', (t) => {
  const files = { 'config/toolchain.json': fixtureConfig('toolchain-go-file.json'), '.go-version': '1.27.0\n', 'go.mod': 'module example.com/fixture\n\ngo 1.27\n' };
  assert.deepEqual(declaredToolchain(toolchainCheckout(t, files)).go, { version: '1.27.0', source: '.go-version' });
  const toolchain = toolchainCheckout(t, { 'config/toolchain.json': '{ "schema": 1, "go": { "mod": "go.mod" } }', 'go.mod': 'module example.com/fixture\n\ngo 1.27\n\ntoolchain go1.27.2\n' });
  assert.deepEqual(declaredToolchain(toolchain).go, { version: '1.27.2', source: 'go.mod toolchain' });
});

test('a declaration that is malformed or contradicts another fails with the file and the values', (t) => {
  const cases = [
    [{ '.node-version': '26.8\n' }, /\.node-version must record the Node\.js release as <major>\.<minor>\.<patch>; it records "26\.8"/],
    [{ 'package.json': '{ "packageManager": "pnpm@11.0.0" }' }, /package\.json packageManager is "pnpm@11\.0\.0", expected npm@/],
    [{ 'package.json': '{}' }, /package\.json packageManager is "", expected npm@/],
    [{ 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n' }, /rust-toolchain\.toml must record channel as <major>\.<minor>\.<patch>; it records "stable"/],
    [{ 'config/toolchain.json': '{ "schema": 1, "python": "3.14" }', '.python-version': '3.13\n' }, /\.python-version declares 3\.13, but config\/toolchain\.json python declares 3\.14/],
    [{ 'config/toolchain.json': '{ "schema": 1, "php": ["8.5"] }', '.php-version': '8.4\n' }, /\.php-version declares 8\.4, but config\/toolchain\.json php lists 8\.5/],
    [{ 'config/toolchain.json': '{ "schema": 1, "go": { "mod": "go.mod", "versionFile": ".go-version" } }', '.go-version': '1.27.0\n', 'go.mod': 'go 1.26\n' }, /go\.mod declares go 1\.26, but \.go-version declares 1\.27\.0; write go 1\.27 in go\.mod/],
    [{ 'config/toolchain.json': '{ "schema": 1, "go": { "mod": "go.mod" } }', 'go.mod': 'go 1.27\n' }, /go\.mod has no toolchain line or go directive <major>\.<minor>\.<patch>; it has "1\.27"/],
    [{ 'config/toolchain.json': '{ "schema": 1, "ruff": { "pyproject": "pyproject.toml" } }', 'pyproject.toml': 'dev = ["ruff==0.1.0", "ruff==0.2.0"]\n' }, /pyproject\.toml must pin one ruff==<major>\.<minor>\.<patch>; it pins 0\.1\.0, 0\.2\.0/],
  ];
  for (const [files, message] of cases) assert.throws(() => declaredToolchain(toolchainCheckout(t, files)), message);
});
