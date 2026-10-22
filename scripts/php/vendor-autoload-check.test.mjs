// Requirements: none. The check of the installed Composer autoload (KSTD-3-2): a stale file that composer.json no longer declares,
// and a declared file that is not installed, both fail; a matching install passes and nothing is repaired.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { differences } from './vendor-autoload-check.mjs';

const composer = JSON.stringify({
  autoload: { files: ['src/functions.php'] },
  'autoload-dev': { files: ['packages/php/tests/bootstrap.php'] },
});
const installed = (...paths) => paths.map(p => `    'h' => $baseDir . '/${p}',`).join('\n');

caseTest('a matching install has no difference', COMPUTE, () => {
  assert.deepEqual(differences(composer, installed('src/functions.php', 'packages/php/tests/bootstrap.php')), { stale: [], missing: [] });
});

caseTest('a stale file that composer.json no longer declares is reported', COMPUTE, () => {
  const { stale } = differences(composer, installed('src/functions.php', 'packages/php/tests/bootstrap.php', 'packages/php/gen/bootstrap.php'));
  assert.deepEqual(stale, ['packages/php/gen/bootstrap.php']);
});

caseTest('a declared file that is not installed is reported as missing', COMPUTE, () => {
  const { missing } = differences(composer, installed('src/functions.php'));
  assert.deepEqual(missing, ['packages/php/tests/bootstrap.php']);
});
