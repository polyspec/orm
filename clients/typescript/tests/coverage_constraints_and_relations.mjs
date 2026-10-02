// constraints_and_relations coverage: database 가 거부한 foreign key, check, unique 위반이 각각
// FOREIGN_KEY, CONSTRAINT, DUPLICATE_KEY 로 보고되고 아무 row 도 바뀌지 않는지 확인한다.
import assert from 'node:assert/strict';
import { Author, Db, User } from '../dist/index.js';
import { errorCode, featureDatabase, runCases } from './coverage_case.mjs';

await runCases('coverage_constraints_and_relations.mjs', {
  async constraint_errors() {
    const { driver, dsn } = featureDatabase();
    const db = await Db.connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      const snapshot = async () => {
        const first = await new Author().connect(db).addAllColumns().getBySeq(1);
        const user = await new User().connect(db).getBySeq(1);
        return { author: first.toJSONText(), user: user.toJSONText() };
      };
      const before = await snapshot();
      const second = await new Author().connect(db).getBySeq(2);
      assert.equal(typeof second.getUuid(), 'string', 'author 2 has a uuid');

      const user = await new User().connect(db).getBySeq(1);
      assert.equal(await errorCode(user.delete()), 'FOREIGN_KEY', 'delete of a referenced user');
      assert.equal(await errorCode(new Author().connect(db).setSeq(1).setLikeCount(-1).update()), 'CONSTRAINT', 'ck_author_counts');
      assert.equal(await errorCode(new Author().connect(db).setSeq(1).setUuid(second.getUuid()).update()), 'DUPLICATE_KEY', 'uq_author_uuid');
      assert.deepEqual(await snapshot(), before, 'the rejected writes changed nothing');
    } finally { await db.close(); }
  },
}, 300_000);
