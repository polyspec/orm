// The MySQL reader of a SHOW CREATE TABLE statement (createChecks of src/dbspec/introspect_mysql.ts, T62-4-8)
// reads every case of tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or
// to no body for a name the statement does not have.
//
// Usage: node --test packages/orm-npm/tests/dbspec-show-create.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecks } from '../dist/dbspec/introspect_mysql.js';

// TIMEOUT은 case 하나의 기한(ms)이다. 문자열 하나를 읽는 계산이다.
const TIMEOUT = 60000;
const data = JSON.parse(readFileSync(new URL('../../../tests/dbspec/show-create.json', import.meta.url), 'utf8'));

for (const c of data.cases) {
  caseTest(`show-create ${c.id}`, TIMEOUT, () => {
    const checks = createChecks(c.create.join('\n') + '\n');
    const got = checks.get(c.name);
    if (c.expected === 'not found') {
      assert.equal(got, undefined, `${c.name} is read as ${JSON.stringify(got)}, want not found`);
      return;
    }
    assert.equal(got, c.expected, `${c.name} is read as ${JSON.stringify(got)}`);
  });
}
