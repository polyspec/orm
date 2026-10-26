import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

caseTest('the dbspec PHP extension aggregate owns the shared module until every case finishes', COMPUTE, () => {
  const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');
  const aggregate = makefile.split('dbspec-php-extension-check:\n')[1]?.split('\ndbspec-php-extension-check/arginfo:')[0];
  assert.ok(aggregate, 'dbspec-php-extension-check aggregate recipe is missing');
  assert.match(aggregate, /trap 'rm -rf "\$\$run_dir"' EXIT/);
  assert.match(aggregate, /\$\(MAKE\).* -k RUN_DIR="\$\$run_dir" DBSPEC_PHP_EXTENSION_SHARED_RUN=1/);
  assert.match(makefile, /^dbspec-php-extension-check\/analyze: DBSPEC_PHP_EXTENSION_CHILD_RUN_DIR = .*dbspec-php-extension-check-analyze-\$\$PPID$/m);
  assert.match(makefile, /^dbspec-php-extension-check\/ir: DBSPEC_PHP_EXTENSION_CHILD_RUN_DIR = .*dbspec-php-extension-check-ir-\$\$PPID$/m);
  assert.equal((makefile.match(/if \[ -z '\$\(DBSPEC_PHP_EXTENSION_SHARED_RUN\)' \]; then trap 'rm -rf "\$\$run_dir"' EXIT; fi;/g) ?? []).length, 2);
  const declarationCommands = makefile.split('\n').filter(line => line.includes('DeclarationsTest.php'));
  assert.ok(declarationCommands.length > 0, 'no DeclarationsTest owner command is registered');
  for (const command of declarationCommands) {
    assert.match(command, /POLYSPEC_ORM_EXTENSION=/, `DeclarationsTest command cannot expose its loaded module: ${command}`);
  }

  const root = new URL('../..', import.meta.url).pathname;
  const directory = mkdtempSync(join(tmpdir(), 'orm-dbspec-php-extension-wrapper-'));
  const temporary = join(directory, 'step-tmp');
  const fakeMake = join(directory, 'make-child');
  const argumentsFile = join(directory, 'child-arguments');
  try {
    mkdirSync(temporary);
    writeFileSync(fakeMake, [
      '#!/bin/sh',
      'set -eu',
      'printf \'%s\\n\' "$@" > "$FAKE_MAKE_ARGUMENTS"',
      'run_dir=',
      'analyze=0',
      'shared=0',
      'keep_going=0',
      'for argument do case "$argument" in RUN_DIR=*) run_dir=${argument#RUN_DIR=};; dbspec-php-extension-check/analyze) analyze=1;; DBSPEC_PHP_EXTENSION_SHARED_RUN=1) shared=1;; -k) keep_going=1;; esac; done',
      'test -n "$run_dir" && test "$analyze" -eq 1 && test "$shared" -eq 1 && test "$keep_going" -eq 1',
      'mkdir -p "$run_dir/php-extension"',
      'printf module > "$run_dir/php-extension/polyspec_orm.so"',
      'exit "${FAKE_MAKE_EXIT:-0}"',
      '',
    ].join('\n'));
    chmodSync(fakeMake, 0o755);

    for (const exitCode of [0, 23]) {
      const runDirectory = join(directory, `run-${exitCode}`);
      const result = spawnSync(
        'make',
        ['--no-print-directory', 'dbspec-php-extension-check', `MAKE=${fakeMake}`, `RUN_DIR=${runDirectory}`],
        { cwd: root, encoding: 'utf8', env: isolatedEnvironment({ TMPDIR: temporary, FAKE_MAKE_ARGUMENTS: argumentsFile, FAKE_MAKE_EXIT: String(exitCode) }) },
      );
      if (exitCode === 0) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
      } else {
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /Error 23/);
      }
      assert.ok(!existsSync(runDirectory), `aggregate left its module directory after submake exit ${exitCode}`);
      const childArguments = readFileSync(argumentsFile, 'utf8');
      assert.match(childArguments, /-k/);
      assert.match(childArguments, /DBSPEC_PHP_EXTENSION_SHARED_RUN=1/);
      assert.match(childArguments, /dbspec-php-extension-check\/analyze/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
