import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { checkSqliteVersion } from '../dist/driver.js';

caseTest('SQLite version parser accepts three or four decimal u32 components', COMPUTE, () => {
  for (const version of ['3.46.0', '3.046.000.0', '3.100.0', '4.0.0', '4294967295.0.0']) {
    assert.doesNotThrow(() => checkSqliteVersion(version), version);
  }
});

caseTest('SQLite version parser rejects malformed values as INTERNAL with the raw input', COMPUTE, () => {
  for (const version of ['', '3.46', '3.46.0.0.0', '3..0', '.46.0', ' 3.46.0', '3.46.0 ', '3.46.0\n', '3.46.0\r', '3.46.0\u2028', '3.46.0\u2029', '+3.46.0', '3.46.0-rc1', '3.4294967296.0', '3.46.0.4294967296', '3.46.0.', '٣.46.0']) {
    assert.throws(
      () => checkSqliteVersion(version),
      error => error.code === 'INTERNAL' && error.message.includes(JSON.stringify(version)),
      version,
    );
  }
});

caseTest('SQLite minimum version comparison is numeric', COMPUTE, () => {
  for (const version of ['3.45.999', '2.999.999', '003.045.999.0']) {
    assert.throws(() => checkSqliteVersion(version), error => error.code === 'CAPABILITY_UNSUPPORTED', version);
  }
});
