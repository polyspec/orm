import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { raise, run } from './raise-version.mts';

const SCRIPT = fileURLToPath(new URL('./raise-version.mts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

caseTest('raise-version raises a plain and an escaped ir_version 1 to 2 with the spacing it is written with', () => {
  assert.equal(raise('{"ir_version": 1, "kind": "all"}'), '{"ir_version": 2, "kind": "all"}');
  assert.equal(raise('{"ir_version":1}'), '{"ir_version":2}');
  assert.equal(raise('"step": "{\\"ir_version\\":1,\\"kind\\":\\"count\\"}"'), '"step": "{\\"ir_version\\":2,\\"kind\\":\\"count\\"}"');
});

caseTest('raise-version keeps another version, a number that only begins with 1, and another member', () => {
  for (const text of ['{"ir_version": 3}', '{"ir_version": 10}', '{"ir_version": 12}', '{"version": 1}', '{"n_params": 1}']) assert.equal(raise(text), text);
});

caseTest('raise-version is a fixed point: a second raise changes nothing', () => {
  const once = raise('[{"ir_version": 1}, "{\\"ir_version\\":1}", {"ir_version": 3}]');
  assert.equal(raise(once), once);
});

caseTest('raise-version names the tracked files of 1 under --check, writes nothing, and raises them without it', () => {
  const base = mkdtempSync(join(tmpdir(), 'raise-version-'));
  try {
    // git init in a folder that holds a .git would set up that repository again.
    assert.equal(existsSync(join(base, '.git')), false, 'the tree holds no .git before it becomes a git root');
    const git = (...args: string[]) => {
      const done = spawnSync('git', args, { cwd: base, encoding: 'utf8', env: isolatedEnvironment() });
      assert.equal(done.status, 0, done.stderr);
    };
    git('init', '--quiet');
    mkdirSync(join(base, 'tests/ir'), { recursive: true });
    mkdirSync(join(base, 'legacy/tests/ir'), { recursive: true });
    writeFileSync(join(base, 'tests/ir/old.json'), '{"ir_version": 1}\n');
    writeFileSync(join(base, 'tests/ir/new.json'), '{"ir_version": 2}\n');
    writeFileSync(join(base, 'tests/ir/untracked.json'), '{"ir_version": 1}\n');
    writeFileSync(join(base, 'legacy/tests/ir/frozen.json'), '{"ir_version": 1}\n');
    git('add', 'tests/ir/old.json', 'tests/ir/new.json', 'legacy/tests/ir/frozen.json');
    assert.deepEqual(run(base, true), ['tests/ir/old.json'], 'only a tracked shared file of 1; legacy/ and untracked files are not read');
    assert.equal(readFileSync(join(base, 'tests/ir/old.json'), 'utf8'), '{"ir_version": 1}\n', '--check writes nothing');
    assert.deepEqual(run(base, false), ['tests/ir/old.json']);
    assert.equal(readFileSync(join(base, 'tests/ir/old.json'), 'utf8'), '{"ir_version": 2}\n');
    assert.equal(readFileSync(join(base, 'legacy/tests/ir/frozen.json'), 'utf8'), '{"ir_version": 1}\n', 'the frozen legacy copy keeps 1 (CORE-1)');
    assert.deepEqual(run(base, true), [], 'after the raise no file holds 1');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

caseTest('raise-version --check passes on the tracked files of this checkout', () => {
  assert.deepEqual(run(ROOT, true), []);
});

caseTest('raise-version refuses an unknown argument with its usage', () => {
  const done = spawnSync(process.execPath, [SCRIPT, '--force'], { encoding: 'utf8' });
  assert.equal(done.status, 2);
  assert.match(done.stderr, /usage: node scripts\/ir\/raise-version\.mts \[--check\]/);
});
