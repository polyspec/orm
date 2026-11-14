// An integer number parameter reaches MySQL as an integer.
import assert from 'node:assert/strict';
import { caseTest } from '../../../../tests/testcase.mts';
import { mysqlParams } from '../dist/driver.js';

// mysql2 sends a JS number as a DOUBLE, which ProxySQL refuses as a LIMIT (T273), so an integral number goes as a bigint
// and every other value is unchanged.
caseTest('driver-param/integer/mysql', () => {
  const bytes = Uint8Array.from([1]);
  assert.deepEqual(mysqlParams([3, 0, -7, 2.5, null, true, 'x', 9n, bytes]), [3n, 0n, -7n, 2.5, null, true, 'x', 9n, bytes]);
});
