// The one build of the PHP extension per source and mode (B1-7): two extension sites of one run share one phpize.
//
//   node --test scripts/php/php-ext-build-cache.test.mts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../../tests/environment.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PHPIZE_LINE = '[php-extension] phpize';

caseTest('two extension sites of one run share one phpize', PROCESS, () => {
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
