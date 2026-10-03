// parameter_chunking coverage: 모든 driver 의 bind 한도를 넘는 root IN list 를 나눠 실행해 중복과
// 없는 값을 포함해도 count 가 맞는지, 나누면 결과가 달라지는 limit 은 IR_INVALID 로 거부하는지
// 확인한다. 읽기만 한다.
import assert from 'node:assert/strict';
import { Author, connect } from '../dist/index.js';
import { errorCode, featureDatabase, runCases } from './coverage_case.mjs';

await runCases('coverage_parameter_chunking.mjs', {
  async root_in_chunking() {
    const { driver, dsn } = featureDatabase();
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
