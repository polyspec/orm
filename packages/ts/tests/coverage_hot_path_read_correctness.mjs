import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Author, connect } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

async function hotPathReadCorrectness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orm-hot-path-'));
  const file = path.join(directory, 'read.sqlite');
  const dsn = `sqlite://${file}`;
  const native = new DatabaseSync(file);
  let db;
  try {
    native.exec('CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)');
    const insert = native.prepare('INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)');
    for (let seq = 1; seq <= 100; seq++) insert.run(seq, `list-${String(seq).padStart(3, '0')}`, 7, 0);
    insert.run(101, 'closed', 7, 1);
    insert.run(102, 'other-service', 8, 0);
    db = await connect(dsn);

    const pk = new Author().connect(db).removeAllColumns().removeColumnUserSeq().removeColumnServiceSeq()
      .removeColumnServiceRegionSeq().removeColumnServiceMemberSeq().seq(42).addColumnSeq().addColumnName().limit(0, 1);
    const pkStatement = await pk.getQuery();
    assert.deepEqual(pkStatement.binds, [42, 1, 0]);
    assertProjection(pkStatement.sql);
    const pkExpected = [[42, 'list-042']];
    assert.deepEqual(nativeRows(native, pkStatement.sql, pkStatement.binds), pkExpected);
    assert.deepEqual(clientRows(await pk.gets()), pkExpected);

    const list = new Author().connect(db).removeAllColumns().removeColumnUserSeq().removeColumnServiceSeq()
      .removeColumnServiceRegionSeq().removeColumnServiceMemberSeq().serviceSeq(7).andIsClose(false)
      .orderBySeqDesc().limit(0, 100).addColumnSeq().addColumnName();
    const listStatement = await list.getQuery();
    assert.deepEqual(listStatement.binds, [7, false, 100, 0]);
    assertProjection(listStatement.sql);
    const listExpected = Array.from({ length: 100 }, (_, index) => {
      const seq = 100 - index;
      return [seq, `list-${String(seq).padStart(3, '0')}`];
    });
    assert.deepEqual(nativeRows(native, listStatement.sql, listStatement.binds), listExpected);
    assert.deepEqual(clientRows(await list.gets()), listExpected);
  } finally {
    if (db) await db.close();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertProjection(sql) {
  const projection = sql.split(' FROM ', 1)[0];
  assert.match(projection, /"a"\."seq" AS "a__seq"/);
  assert.match(projection, /"a"\."name" AS "a__name"/);
  assert.doesNotMatch(projection, /created_ts|service_seq/);
}

function nativeRows(db, sql, binds) {
  return db.prepare(sql).all(...binds).map((row) => [Number(row.a__seq), row.a__name]);
}

function clientRows(rows) {
  return [...rows].map((row) => [row.getSeq(), row.getName()]);
}

await runCases('coverage_hot_path_read_correctness.mjs', {
  hot_path_read_correctness: hotPathReadCorrectness,
}, 60_000);
