// The split of the docs gates (KSTD-5-48): docs-check runs only the Markdown checks, and the VitePress site build with the checks
// that read the built site runs in docs-site-check. The land of a branch runs docs-check, so the expansion of its recipe must not
// name the site build (npm run docs:check, which runs docs:build).
//
// Usage: node --test tests/docs/split.test.mts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { caseTest } from '../testcase.mts';

const TIMEOUT = 120_000;

// dryRun returns the commands that make would run for a target, without running them.
const dryRun = (target: string): string => execFileSync('make', ['-n', target], { encoding: 'utf8' });

caseTest('docs-check expands to no site build, so a land runs no docs:build', TIMEOUT, () => {
  const commands = dryRun('docs-check');
  assert.ok(!commands.includes('docs:check'), `docs-check still runs the site build:\n${commands}`);
  assert.ok(!commands.includes('docs:build'), `docs-check still runs docs:build:\n${commands}`);
});

caseTest('docs-site-check expands to the site build and the checks that read the built site', TIMEOUT, () => {
  const commands = dryRun('docs-site-check');
  assert.ok(commands.includes('docs:check'), `docs-site-check does not run the site build:\n${commands}`);
});
