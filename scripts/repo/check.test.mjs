import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { scriptPathErrors } from './scripts.mjs';

const tracked = ['scripts/docs/rules.mjs', 'clients/typescript/package.json', 'scripts/typescript/sqlite-test.sh'];

caseTest('a script path must be a tracked file or directory', COMPUTE, () => {
  assert.deepEqual(scriptPathErrors({ 'schema:check': 'node scripts/schema/check.mjs' }, tracked), [
    'package.json script schema:check names scripts/schema/check.mjs, which is not a tracked file or directory',
  ]);
  assert.deepEqual(
    scriptPathErrors(
      {
        'docs:rules-check': 'node scripts/docs/rules.mjs',
        'typescript:build': 'npm --prefix clients/typescript run build',
        'typescript:test': 'npm run typescript:build && ./scripts/typescript/sqlite-test.sh',
        'docs:dev': 'vitepress dev docs',
      },
      tracked,
    ),
    [],
  );
});
