// model_queries coverage: 생성된 model 의 조건, 정렬, limit, 합계, 관계 읽기를 seed 된 bench
// database 에서 확인한다. 읽기만 한다.
import assert from 'node:assert/strict';
import { Author, Db, User } from '../dist/index.js';
import { featureDatabase, runCases } from './coverage_case.mjs';

await runCases('coverage_model_queries.mjs', {
  async model_query_rows() {
    const { driver, dsn } = featureDatabase();
    const db = await Db.connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      assert.equal(await new Author().connect(db).userSeq(1).getCount(), 20, 'authors of user 1');
      const rows = await new Author().connect(db).serviceSeq(7).orderBySeqDesc().limit(0, 3).gets();
      assert.deepEqual(rows.values().map(b => b.getName()), ['author-99906', 'author-99806', 'author-99706'], 'ordered and limited rows');
      assert.equal(await new Author().connect(db).serviceSeq(7).sumReadCount().getSum(), 456000, 'sum of read_count');
      const author = await new Author().connect(db).relation(new User().matchUserSeqWithSeq()).getBySeq(5000);
      assert.equal(author.getUserModel()?.getName(), 'user-1', 'user loaded through the relation');
    } finally { await db.close(); }
  },
}, 300_000);
