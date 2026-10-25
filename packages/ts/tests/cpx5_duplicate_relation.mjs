// Requirements: CPX-5.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Author, User, connect } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

await runCases('cpx5_duplicate_relation.mjs', {
  async duplicate_relation_name() {
    const dir = mkdtempSync(join(tmpdir(), 'orm-cpx5-ts-'));
    let db;
    try {
      db = await connect(`sqlite://${join(dir, 'test.sqlite')}`);
      const query = new Author().connect(db)
        .relation(new User().matchUserSeqWithSeq())
        .relation(new User().matchUserSeqWithSeq());
      await assert.rejects(query.getQuery(), error => {
        assert.equal(error.code, 'CONFIG');
        assert.match(error.message, /user_model/);
        assert.match(error.message, /alias<Name>\(\)/);
        return true;
      });
    } finally {
      if (db) await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
}, 300_000);
