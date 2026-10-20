// model_queries coverage: checks the conditions, ordering, limit, sums, and relation reads of the generated model on the seeded bench
// database. It only reads.
import assert from 'node:assert/strict';
import { Author, User, connect } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

await runCases('coverage_model_queries.mjs', {
  // Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-80, DSL-82, DSL-99, PLN-11.
  async model_query_rows({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
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
