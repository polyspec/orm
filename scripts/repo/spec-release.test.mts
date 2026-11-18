// The release-spec check (T682): an identifier of the released spec that the current spec no longer holds fails. A changed body
// is a review entry, and a retired marker passes. The fixtures are the statement of CFG-35 in v0.0.33 and before the change that retired it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import { releasedSpecErrors } from './spec-release.mts';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/spec-release/${name}`, import.meta.url)), 'utf8');

caseTest('a released identifier whose body changed is a review entry, not a failure', () => {
  // A changed body is a meaning a reviewer judges (review list, HR-84), so the check does not fail on it.
  assert.deepEqual(releasedSpecErrors(fixture('released.md'), fixture('changed.md'), 'v0.0.33'), []);
});

caseTest('a released identifier that is retired in the current spec passes', () => {
  assert.deepEqual(releasedSpecErrors(fixture('released.md'), fixture('retired.md')), []);
});

caseTest('a released identifier absent from the current spec fails and names its tag', () => {
  const errors = releasedSpecErrors(fixture('released.md'), fixture('absent.md'), 'v0.0.33');
  assert.equal(errors.length, 1, `want one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /CFG-35/);
  assert.match(errors[0], /v0\.0\.33/);
});

caseTest('a repository without a version tag is an error, not a pass', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(`${tmpdir()}/spec-release-`);
  try {
    execFileSync('git', ['init', '-q', dir]);
    const mod = await import('./spec-release.mts');
    assert.throws(() => mod.releasedSpecFor(dir, 'docs/spec/config.md'), /no version tag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
