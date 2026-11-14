// The one build of the PHP extension per source and mode (B1-7): two extension sites of one run share one phpize.
//
//   node --test scripts/php/php-ext-build-cache.test.mts
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../../tests/environment.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PHPIZE_LINE = '[php-extension] phpize';

caseTest('two extension sites of one run share one phpize', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'php-ext-build-cache-'));
  try {
    const outputs = [path.join(scratch, 'first', 'polyspec_orm.so'), path.join(scratch, 'second', 'polyspec_orm.so')];
    let log = '';
    for (const output of outputs) {
      const result = spawnSync('make', ['--no-print-directory', 'php-ext-build', `PHP_EXT_OUT=${output}`, 'PHP_EXT_MODE=release'], {
        cwd: root,
        env: isolatedEnvironment(),
        encoding: 'utf8',
      });
      log += result.stdout + result.stderr;
      assert.equal(result.status, 0, `make php-ext-build ${output} exited with ${result.status ?? result.signal}:\n${log}`);
      assert.ok(existsSync(output), `make php-ext-build did not write ${output}`);
    }
    const phpizeRuns = log.split('\n').filter(line => line.includes(PHPIZE_LINE)).length;
    assert.ok(phpizeRuns <= 1, `two sites of one run ran phpize ${phpizeRuns} times, expected at most one:\n${log}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// build.sh names the extension and the PHP library by their directories below the repository, legacy/packages/php-ext and
// legacy/packages/php (T481): it runs in a checkout of that layout with a stand-in node, which answers the path of the kit
// builder and records the arguments of the build, so the case needs no compiler and no PHP.
caseTest('build.sh names the extension and the PHP library below legacy/ (T481)', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'php-ext-build-paths-'));
  try {
    const checkout = path.join(scratch, 'checkout');
    const scripts = path.join(checkout, 'legacy/packages/php-ext/scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(path.join(root, 'legacy/packages/php-ext/scripts/build.sh'), path.join(scripts, 'build.sh'));
    for (const directory of ['legacy/packages/php/src/native', 'legacy/packages/php-ext/src/native']) mkdirSync(path.join(checkout, directory), { recursive: true });
    writeFileSync(path.join(checkout, 'legacy/packages/php/src/native/sqlite_cancel.c'), '/* the callback */\n');
    assert.equal(spawnSync('git', ['init', '-q', checkout]).status, 0, 'git init of the stand-in checkout failed');
    const tools = path.join(scratch, 'tools');
    mkdirSync(tools);
    const recorded = path.join(scratch, 'arguments');
    writeFileSync(path.join(tools, 'node'), `#!/bin/sh\nif [ "$1" = -p ]; then echo /stand-in/kit/php-extension.mjs; exit 0; fi\nprintf '%s\\n' "$@" > '${recorded}'\n`);
    chmodSync(path.join(tools, 'node'), 0o755);
    const run = () => spawnSync('sh', [path.join(scripts, 'build.sh'), path.join(scratch, 'out/polyspec_orm.so'), 'release'], {
      cwd: scratch,
      env: { PATH: `${tools}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    // Without the copy of the SQLite cancel callback the build is refused, naming the paths of this layout.
    const refused = run();
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /legacy\/packages\/php-ext\/src\/native\/sqlite_cancel\.c is missing or differs from legacy\/packages\/php\/src\/native\/sqlite_cancel\.c; run make legacy\/packages\/php-ext\/src\/native\/sqlite_cancel\.c/);
    copyFileSync(path.join(checkout, 'legacy/packages/php/src/native/sqlite_cancel.c'), path.join(checkout, 'legacy/packages/php-ext/src/native/sqlite_cancel.c'));
    const built = run();
    assert.equal(built.status, 0, built.stderr);
    const words = readFileSync(recorded, 'utf8').trim().split('\n');
    const after = (flag: string) => words[words.indexOf(flag) + 1];
    assert.deepEqual([after('--extension'), after('--library')], ['legacy/packages/php-ext', 'legacy/packages/php'], words.join(' '));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
