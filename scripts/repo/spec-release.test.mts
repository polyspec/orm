// The release-spec check (T682): an identifier of the released spec whose body changed in the current spec fails, and a
// retired marker passes. The fixtures are the statement of CFG-35 in v0.0.33 and before the change that retired it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releasedSpecErrors } from './spec-release.mts';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/spec-release/${name}`, import.meta.url)), 'utf8');

test('a released identifier whose body changed without a retired marker fails', () => {
  const errors = releasedSpecErrors(fixture('released.md'), fixture('changed.md'));
  assert.equal(errors.length, 1, `want one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /CFG-35/);
});

test('a released identifier that is retired in the current spec passes', () => {
  assert.deepEqual(releasedSpecErrors(fixture('released.md'), fixture('retired.md')), []);
});
