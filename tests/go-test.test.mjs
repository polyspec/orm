// tests/go-test.mjs의 build 단계 인자 test다. 실행 flag는 build에서 빠지고, package, build tag와
// build flag는 남는다.
import assert from 'node:assert/strict';
import { buildArguments, packages } from './go-test.mjs';
import { caseTest, COMPUTE } from './testcase.mjs';

caseTest('the build step keeps packages and build flags and runs no test', COMPUTE, () => {
  assert.deepEqual(buildArguments(['-v', '-timeout', '0', '-tags', 'physical', './tests/dialects', '-run', '^(TestA|TestB)$', '-count=1']),
    ['-tags', 'physical', './tests/dialects', '-run', '^$', '-count=1']);
  assert.deepEqual(buildArguments(['-v', '-timeout=0', '-count', '1', '-race', './clients/go/...', '-run=X']), ['-race', './clients/go/...', '-run', '^$', '-count=1']);
  assert.equal(packages(['-v', './clients/go/orm', './clients/go/orm/pg', '-run', 'X']), 'clients/go/orm,clients/go/orm/pg');
  assert.equal(packages(['-v']), '.');
});
