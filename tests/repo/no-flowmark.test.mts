import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { caseTest } from '../testcase.mts';

// orm produces what flowmark consumes, so no test of orm runs a flowmark server: the client rules of a markdown connection
// are checked on the scripted listener of markdown.session, and a server that answers as SQLite does is flowmark's
// requirement (DIA-226, FCV-22).
const root = new URL('../..', import.meta.url).pathname;
const self = 'tests/repo/no-flowmark.test.mts';

// Each use names what makes a test need the flowmark program: the FLOWMARK variable that hands its path to a test, the
// make targets that install or require it, and the pin of the version that they install.
const uses: ReadonlyArray<readonly [string, RegExp]> = [
  ['the FLOWMARK variable', /\bFLOWMARK\b/],
  ['the target flowmark-check', /(?<![\w-])flowmark-check\b/],
  ['the target orm-install-flowmark', /\borm-install-flowmark\b/],
  ['the pin tests/markdown/flowmark.version', /\bflowmark\.version\b/],
];

caseTest('the pattern of flowmark-check names that target and no target whose name ends in it', () => {
  const pattern = uses.find(([name]) => name === 'the target flowmark-check')?.[1];
  assert.ok(pattern);
  assert.equal(pattern.test('\tmake flowmark-check'), true);
  assert.equal(pattern.test('suite-php-check: flowmark-check php-vendor-check'), true);
  assert.equal(pattern.test('no-flowmark-check:'), false);
  assert.equal(pattern.test('CHECK_TARGETS = makefile-pinned-node-recipes-check no-flowmark-check'), false);
});

function trackedFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  // Prose records the history and the rules; the rule here is about what runs.
  return listed.stdout.split('\0').filter(path => path !== '' && path !== self && !path.endsWith('.md') && !path.startsWith('docs/'));
}

caseTest('no test, recipe or make target of orm needs the flowmark program', () => {
  const found: string[] = [];
  for (const path of trackedFiles()) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const [name, pattern] of uses) if (pattern.test(line)) found.push(`${path}:${index + 1}: ${name}`);
    });
  }
  if (existsSync(join(root, 'tests/markdown/flowmark.version'))) found.push('tests/markdown/flowmark.version: the pin of a flowmark that orm runs');
  assert.deepEqual(found, [], `orm needs the flowmark program at:\n${found.join('\n')}`);
});
