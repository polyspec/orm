// A MySQL lock wait timeout (1205, innodb_lock_wait_timeout) is the expiry of the write bound of CFG-6, so driverError
// classifies it as CANCELED, not DRIVER. The case builds the error of the driver and needs no database.
//
// Usage: npm run typescript:build && node --test packages/ts/tests/driver-error-lock-wait.mjs
import assert from 'node:assert/strict';
import { driverError } from '../dist/driver.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

caseTest('driver-error/lock-wait-timeout/mysql', COMPUTE, () => {
  const error = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
  assert.equal(driverError('mysql', error).code, 'CANCELED');
});
