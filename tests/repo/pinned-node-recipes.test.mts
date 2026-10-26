import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../testcase.mts';
import { isolatedEnvironment } from '../environment.mts';

caseTest('the dbspec verification and TypeScript package entry recipes use the pinned Node wrapper', COMPUTE, () => {
  const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');
  assert.match(makefile, /^\t\$\(NODE\) --test packages\/ts\/tests\/dbspec-apply-verify-errors\.mjs$/m);
  assert.match(makefile, /^\t\$\(NODE\) --conditions=orm-test --test --test-name-pattern='package-entry\/runtime-exports' packages\/ts\/tests\/statement_fault_entry\.mjs$/m);
});

caseTest('the collection PHPStan recipe removes its private cache after success and failure', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const directory = mkdtempSync(join(tmpdir(), 'orm-collection-phpstan-recipe-'));
  const temporary = join(directory, 'step-tmp');
  const fakePhpstan = join(directory, 'phpstan');
  try {
    mkdirSync(temporary);
    writeFileSync(fakePhpstan, [
      '#!/bin/sh',
      'set -eu',
      'configuration=',
      'for argument do case "$argument" in --configuration=*) configuration=${argument#--configuration=};; esac; done',
      'test -n "$configuration"',
      'cache=$(sed -n \'s/^    tmpDir: //p\' "$configuration")',
      'test -n "$cache"',
      'mkdir -p "$cache"',
      'exit "${PHPSTAN_EXIT:-0}"',
      '',
    ].join('\n'));
    chmodSync(fakePhpstan, 0o755);

    for (const exitCode of [0, 23]) {
      const result = spawnSync(
        'make',
        ['--no-print-directory', 'collection-get-phpstan-check', `PHPSTAN=${fakePhpstan}`],
        { cwd: root, encoding: 'utf8', env: isolatedEnvironment({ TMPDIR: temporary, PHPSTAN_EXIT: String(exitCode) }) },
      );
      if (exitCode === 0) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
      } else {
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /Error 23/);
      }
      assert.deepEqual(readdirSync(temporary), [], `PHPStan left temporary entries after exit ${exitCode}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

caseTest('the catalog PHP extension surface recipe removes its build directory on every exit', COMPUTE, () => {
  const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');
  const recipe = makefile.split('catalog-php-extension-surface-check: php-vendor-check php-models\n')[1]?.split(/\n[A-Za-z0-9_./%-]+:/, 1)[0];
  assert.ok(recipe, 'catalog-php-extension-surface-check recipe is missing');
  assert.match(recipe, /run_dir="\$\(RUN_DIR\)"/);
  assert.match(recipe, /trap 'rm -rf "\$\$run_dir"' EXIT/);
});
