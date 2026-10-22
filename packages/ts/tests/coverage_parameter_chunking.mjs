// parameter_chunking coverage: runs a root IN list that exceeds every driver's bind limit split into chunks, checking duplicates
// and missing values are still counted correctly, and that a limit whose result changes when split is rejected with IR_INVALID
// are checked. It only reads.
import assert from 'node:assert/strict';
import { Author, connect } from '../dist/index.js';
import { errorCode, runCases } from './coverage_case.mjs';

await runCases('coverage_parameter_chunking.mjs', {
  // PRT-76: a root IN list longer than the bind limit is split into chunks, and a limit on the split list fails with IR_INVALID.
  async root_in_chunking({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      const values = [];
      for (let seq = 1; seq <= 70000; seq++) values.push(seq);
      for (let seq = 1; seq <= 200; seq++) values.push(seq);
      for (let seq = 200001; seq <= 200100; seq++) values.push(seq);
      assert.equal(await new Author().connect(db).seq(values).getCount(), 70000, 'count of the split IN list');
      assert.equal(await errorCode(new Author().connect(db).seq(values).limit(0, 10).gets()), 'IR_INVALID', 'a limit on a split IN list');
    } finally { await db.close(); }
  },
}, 300_000);
