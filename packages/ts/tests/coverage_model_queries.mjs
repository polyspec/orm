// model_queries coverage: checks the conditions, ordering, limit, sums, and relation reads of the generated model on the seeded bench
// database. It only reads.
import assert from 'node:assert/strict';
import { Author, ServiceMember, User, connect } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

await runCases('coverage_model_queries.mjs', {
  // Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25, PLN-35.
  async model_query_rows({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      assert.equal(await new Author().connect(db).seq(-1).get(), null, 'get for a missing author');
      assert.equal(await new Author().connect(db).userSeq(1).getCount(), 20, 'authors of user 1');
      const rows = await new Author().connect(db).serviceSeq(7).orderBySeqDesc().limit(0, 3).gets();
      assert.deepEqual(rows.values().map(b => b.getName()), ['author-99906', 'author-99806', 'author-99706'], 'ordered and limited rows');
      const query = new Author().connect(db).serviceSeq(7).orderBySeqDesc();
      const page = await query.getsPage(1, 3);
      assert.deepEqual(page.items.values().map(b => b.getName()), rows.values().map(b => b.getName()), 'first page contains the first ordered rows');
      assert.equal(page.totalCount, await query.getCount(), 'page total matches getCount');
      assert.equal(await new Author().connect(db).serviceSeq(7).sumReadCount().getSum(), 456000, 'sum of read_count');
      let joinSQL = '';
      const unsubscribe = db.subscribe(event => { if (event.kind === 'select') joinSQL = event.sql; });
      const joined = await new Author().connect(db).serviceSeq(7)
        .joinServiceMemberSeqWithSeq(new ServiceMember().forceIndexIxServiceMemberService())
        .joinUserSeqWithSeq(new User().on(user => user.neName('nobody'))
          .addColumnReadTotal(user => new Author().sumReadCount().userSeqEqSeq(user))
          .orderBySeqDesc())
        .gets();
      unsubscribe();
      if (driver === 'sqlite') assert.ok(joinSQL.includes('INDEXED BY "ix_service_member_service"'), `joined table forceIndex: ${joinSQL}`);
      if (driver === 'mysql') assert.ok(joinSQL.includes('FORCE INDEX (`ix_service_member_service`)'), `joined table forceIndex: ${joinSQL}`);
      const joinedRows = joined.values();
      assert.ok(joinedRows.length > 0, 'joined query returns authors');
      let previousUserSeq;
      for (const row of joinedRows) {
        const user = row.getUserModel();
        assert.ok(user, 'joined user');
        if (previousUserSeq !== undefined) assert.ok(user.getSeq() <= previousUserSeq, 'joined order is descending');
        previousUserSeq = user.getSeq();
        assert.equal(user.getReadTotal(), BigInt(await new Author().connect(db).userSeq(user.getSeq()).sumReadCount().getSum()), 'joined aggregate');
      }
      const author = await new Author().connect(db).relation(new User().matchUserSeqWithSeq()).getBySeq(5000);
      assert.equal(author.getUserModel()?.getName(), 'user-1', 'user loaded through the relation');
    } finally { await db.close(); }
  },
}, 300_000);
