// Tests of the schema validator and of the configuration check of kit-check: the schemas accept the fixture's
// configuration and name each error of a configuration that breaks them.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig } from '../../scripts/kit/kit-check.mjs';
import { validate } from '../../scripts/kit/schema-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixture');

test('the schemas accept the configuration of the fixture', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts/kit/schema'), { recursive: true });
  for (const name of ['dependency-policy', 'dependency-review']) {
    cpSync(path.join(HERE, '../../scripts/kit/schema', `${name}.schema.json`), path.join(root, 'scripts/kit/schema', `${name}.schema.json`));
  }
  mkdirSync(path.join(root, 'config'), { recursive: true });
  for (const name of ['dependency-policy', 'dependency-review']) cpSync(path.join(FIXTURE, 'config', `${name}.json`), path.join(root, 'config', `${name}.json`));
  assert.deepEqual(checkConfig(root), []);
  const policy = path.join(root, 'config/dependency-policy.json');
  writeFileSync(policy, JSON.stringify({ schema: 2, composerPlatforms: [], pythonManifests: [], exceptions: [], extra: true }));
  const findings = checkConfig(root);
  assert.ok(findings.some(line => line === 'config/dependency-policy.json: $.schema is 2, the schema requires 1. Rule: scripts/kit/schema/dependency-policy.schema.json'), findings.join('\n'));
  assert.ok(findings.some(line => line.startsWith('config/dependency-policy.json: $.extra is not in the schema')), findings.join('\n'));
  rmSync(policy);
  assert.deepEqual(checkConfig(root), [], 'a repository without a declared configuration file has no finding');
});

test('the validator names the type, the enumeration and the pattern of a value', () => {
  const schema = { type: 'object', required: ['name'], additionalProperties: false, properties: {
    name: { type: 'string', pattern: '^a' }, kind: { type: 'string', enum: ['npm'] }, list: { type: 'array', minItems: 1, items: { type: 'integer' } },
  } };
  assert.deepEqual(validate({ name: 'b', kind: 'pip', list: [] }, schema), [
    '$.name is "b", the schema requires a match of ^a',
    '$.kind is "pip", the schema allows "npm"',
    '$.list has 0 items, the schema requires at least 1',
  ]);
  assert.deepEqual(validate('x', schema), ['$ is string, the schema requires object']);
  assert.throws(() => validate({}, { oneOf: [] }), /schema keyword oneOf at \$ is not supported by kit/);
});

test('a Composer manifest of the policy is a relative path to a composer.json, at the root or below it', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, '../../scripts/kit/schema/dependency-policy.schema.json'), 'utf8'));
  const policy = manifest => ({ schema: 1, composerPlatforms: [{ manifest, php: '8.2.0' }], pythonManifests: [], exceptions: [] });
  for (const manifest of ['composer.json', 'examples/board/composer.json']) assert.deepEqual(validate(policy(manifest), schema), [], manifest);
  for (const manifest of ['/composer.json', 'a\\composer.json', 'xcomposer.json', 'composer.lock']) assert.notDeepEqual(validate(policy(manifest), schema), [], manifest);
});

test('a Python manifest of the policy is a relative path to a pyproject.toml, at the root or below it', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, '../../scripts/kit/schema/dependency-policy.schema.json'), 'utf8'));
  const policy = manifest => ({ schema: 1, composerPlatforms: [], pythonManifests: [manifest], exceptions: [] });
  for (const manifest of ['pyproject.toml', 'packages/x-python/pyproject.toml']) assert.deepEqual(validate(policy(manifest), schema), [], manifest);
  for (const manifest of ['/pyproject.toml', 'xpyproject.toml', 'setup.py']) assert.notDeepEqual(validate(policy(manifest), schema), [], manifest);
});
